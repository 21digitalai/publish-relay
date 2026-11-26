import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPost } from '../src/modules/content/post.service.js';
import { replacePostMediaInTransaction } from '../src/modules/content/post-media.service.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import { claimDueJobs } from '../src/modules/scheduler/job.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000201';
const userId = '00000000-0000-4000-8000-000000000202';
const accountOne = '00000000-0000-4000-8000-000000000203';
const accountTwo = '00000000-0000-4000-8000-000000000204';
const declaredXAccount = '00000000-0000-4000-8000-000000000230';
const standardXAccount = '00000000-0000-4000-8000-000000000231';

const url = process.env.POSTGRES_MEDIA_TEST_URL;
const suite = url ? describe : describe.skip;
suite('real PostgreSQL media amendment concurrency', () => {
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  const databaseName = 'relay_media_test_' + randomUUID().replaceAll('-', '');
  const testUrl = new URL(url ?? 'postgresql://localhost/postgres');
  testUrl.pathname = '/' + databaseName;
  const pool = new pg.Pool({ connectionString: testUrl.toString(), max: 5 });
  const db = drizzle(pool);
  beforeAll(async () => {
    await admin.query('CREATE DATABASE ' + databaseName);
    const journal = JSON.parse(await readFile('migrations/meta/_journal.json', 'utf8')) as {
      entries: { tag: string }[];
    };
    for (const entry of journal.entries)
      await pool.query(await readFile('migrations/' + entry.tag + '.sql', 'utf8'));
  }, 60000);
  beforeEach(async () => {
    await pool.query('TRUNCATE workspaces, users CASCADE');
    await pool.query(`
    INSERT INTO workspaces (id, name, slug) VALUES ('${workspaceId}', 'Post Workspace', 'post-workspace');
    INSERT INTO users (id, display_name, email, password_hash) VALUES ('${userId}', 'Post Owner', 'post@example.test', 'redacted');
    SELECT set_config('app.workspace_id', '${workspaceId}', false);
    INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${workspaceId}', '${userId}', 'owner');
    INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
      VALUES ('00000000-0000-4000-8000-000000000205', '${workspaceId}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
    INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
      VALUES ('00000000-0000-4000-8000-000000000206', '${workspaceId}', 'fake', '00000000-0000-4000-8000-000000000205');
    INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, destination_provider, remote_account_id, display_name) VALUES
      ('${accountOne}', '${workspaceId}', '00000000-0000-4000-8000-000000000206', 'one', 'fake', 'one', 'One'),
      ('${accountTwo}', '${workspaceId}', '00000000-0000-4000-8000-000000000206', 'two', 'fake', 'two', 'Two');
    INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, destination_provider, remote_account_id, display_name, x_long_posts_allowed) VALUES
      ('${declaredXAccount}', '${workspaceId}', '00000000-0000-4000-8000-000000000206', 'x-one', 'x', 'x-one', 'Declared X', true),
      ('${standardXAccount}', '${workspaceId}', '00000000-0000-4000-8000-000000000206', 'x-two', 'x', 'x-two', 'Standard X', false);
  `);
  });
  afterAll(async () => {
    await pool.end();
    await admin.query('DROP DATABASE IF EXISTS ' + databaseName + ' WITH (FORCE)');
    await admin.end();
  });

  async function fixture() {
    const oldMediaId = '00000000-0000-4000-8000-000000000291';
    const newMediaId = '00000000-0000-4000-8000-000000000292';
    await pool.query(`INSERT INTO media_objects (id,workspace_id,storage_key,sha256,mime_type,byte_size,state)
      VALUES ('${oldMediaId}','${workspaceId}','old.jpg','old','image/jpeg',100,'ready'),
        ('${newMediaId}','${workspaceId}','new.jpg','new','image/jpeg',100,'ready')`);
    const due = new Date('2026-11-26T12:00:00Z');
    const created = await createPost(db, {
      workspaceId,
      userId,
      content: { type: 'text', text: 'Unchanged caption' },
      mediaIds: [oldMediaId],
      providerAccountIds: [accountOne, accountTwo],
      scheduledAt: due,
    });
    const input = {
      workspaceId,
      userId,
      postId: created.postId,
      expectedRevisionId: created.revisionId,
      replacements: [{ oldMediaId, newMediaId }],
    };
    return { created, input, due };
  }

  it('has exactly one winning concurrent amendment and one current job per target', async () => {
    const { input } = await fixture();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        withTenantTransaction(db, { workspaceId, userId }, (tx) =>
          replacePostMediaInTransaction(tx, input),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      (
        await pool.query<{ n: number }>(
          "select provider_account_id,count(*)::int n from publication_jobs where state='scheduled' group by provider_account_id",
        )
      ).rows.map((r) => r.n),
    ).toEqual([1, 1]);
    expect((await pool.query('select id from post_revisions')).rows).toHaveLength(2);
  });

  it('a claim holding a job lock wins; amendment rolls back with zero new jobs', async () => {
    const { input, due } = await fixture();
    const claimant = await pool.connect();
    try {
      await claimant.query('BEGIN');
      await claimDueJobs(drizzle(claimant), {
        workerId: 'claim-first',
        now: due,
        leaseMs: 60000,
        limit: 1,
      });
      const replacing = withTenantTransaction(db, { workspaceId, userId }, (tx) =>
        replacePostMediaInTransaction(tx, input),
      );
      await claimant.query('COMMIT');
      await expect(replacing).rejects.toThrow('before every target dispatches');
      expect((await pool.query('select id from publication_jobs')).rows).toHaveLength(2);
      expect((await pool.query('select id from post_revisions')).rows).toHaveLength(1);
    } finally {
      await claimant.query('ROLLBACK');
      claimant.release();
    }
  });

  it('amendment locks exclude scheduler claims until atomic commit; only replacement jobs can be claimed', async () => {
    const { input, due } = await fixture();
    const editor = await pool.connect();
    try {
      await editor.query('BEGIN');
      const changed = await replacePostMediaInTransaction(drizzle(editor), input);
      expect(
        await claimDueJobs(db, { workerId: 'while-editing', now: due, leaseMs: 60000, limit: 10 }),
      ).toEqual([]);
      await editor.query('COMMIT');
      const claimed = await claimDueJobs(db, {
        workerId: 'after-editing',
        now: due,
        leaseMs: 60000,
        limit: 10,
      });
      expect(claimed.map((job) => job.id).sort()).toEqual(changed.jobIds.sort());
      expect(claimed).toHaveLength(2);
    } finally {
      await editor.query('ROLLBACK');
      editor.release();
    }
  });
});
