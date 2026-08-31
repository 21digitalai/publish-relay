import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTemporaryMedia, storeMedia } from '../src/modules/content/media.service.js';
import type { MediaStorage } from '../src/modules/content/media-storage.js';
import { createPost, editPost } from '../src/modules/content/post.service.js';

const migrations = [
  '0000_identity_tenancy.sql',
  '0001_solid_spiral.sql',
  '0002_busy_mantis.sql',
  '0003_many_marvel_boy.sql',
  '0004_easy_doctor_spectrum.sql',
  '0005_round_thunderball.sql',
];
const workspaceId = '00000000-0000-4000-8000-000000000201';
const userId = '00000000-0000-4000-8000-000000000202';
const accountOne = '00000000-0000-4000-8000-000000000203';
const accountTwo = '00000000-0000-4000-8000-000000000204';
let database: PGlite;

class FakeMediaStorage implements MediaStorage {
  readonly objects = new Map<string, Buffer>();
  shouldFailPut = false;

  put(input: {
    workspaceId: string;
    mediaId: string;
    bytes: Buffer;
    mimeType: string;
  }): Promise<{ storageKey: string }> {
    const hash = createHash('sha256').update(input.bytes).digest('hex');
    const storageKey = `${input.workspaceId}/${input.mediaId}/${hash}`;
    if (this.shouldFailPut) return Promise.reject(new Error('Storage unavailable'));
    this.objects.set(storageKey, input.bytes);
    return Promise.resolve({ storageKey });
  }

  delete(storageKey: string): Promise<void> {
    this.objects.delete(storageKey);
    return Promise.resolve();
  }
}

beforeEach(async () => {
  database = new PGlite();
  for (const migration of migrations)
    await database.exec(
      await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'),
    );
  await database.exec(`
    INSERT INTO workspaces (id, name, slug) VALUES ('${workspaceId}', 'Post Workspace', 'post-workspace');
    INSERT INTO users (id, email, password_hash) VALUES ('${userId}', 'post@example.test', 'redacted');
    SELECT set_config('app.workspace_id', '${workspaceId}', false);
    INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${workspaceId}', '${userId}', 'owner');
    INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
      VALUES ('00000000-0000-4000-8000-000000000205', '${workspaceId}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
    INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
      VALUES ('00000000-0000-4000-8000-000000000206', '${workspaceId}', 'fake', '00000000-0000-4000-8000-000000000205');
    INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, display_name) VALUES
      ('${accountOne}', '${workspaceId}', '00000000-0000-4000-8000-000000000206', 'one', 'One'),
      ('${accountTwo}', '${workspaceId}', '00000000-0000-4000-8000-000000000206', 'two', 'Two');
  `);
});

afterEach(async () => database.close());

describe('post revision lifecycle', () => {
  it('creates independent targets and supersedes only jobs that have not started dispatch', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const scheduledAt = new Date('2026-09-01T10:00:00.000Z');
    const created = await createPost(db, {
      workspaceId,
      userId,
      content: { type: 'text', text: 'First revision' },
      mediaIds: [],
      providerAccountIds: [accountOne, accountTwo],
      scheduledAt,
    });
    expect(created.jobIds).toHaveLength(2);
    const dispatchingJobId = created.jobIds[0];
    if (!dispatchingJobId) throw new Error('Expected first publication job');
    await database.exec(
      `UPDATE publication_jobs SET state = 'dispatching' WHERE id = '${dispatchingJobId}'`,
    );
    const edited = await editPost(db, {
      workspaceId,
      userId,
      postId: created.postId,
      content: { type: 'text', text: 'Second revision' },
      mediaIds: [],
      providerAccountIds: [accountOne, accountTwo],
      scheduledAt,
      now: new Date('2026-08-31T16:00:00.000Z'),
    });
    expect(edited.jobIds).toHaveLength(2);
    expect(edited.supersededJobIds).toEqual([created.jobIds[1]]);
    const jobs = await database.query<{ state: string; revision_number: number }>(`
      SELECT j.state, r.revision_number
      FROM publication_jobs j JOIN post_revisions r ON r.id = j.revision_id
      ORDER BY r.revision_number, j.id
    `);
    expect(jobs.rows.map((row) => row.state).sort()).toEqual([
      'dispatching',
      'scheduled',
      'scheduled',
      'superseded',
    ]);
    expect(jobs.rows.map((row) => row.revision_number)).toEqual([1, 1, 2, 2]);
  });

  it('rejects duplicate account targets before persistence', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    await expect(
      createPost(db, {
        workspaceId,
        userId,
        content: { type: 'text', text: 'Duplicate target' },
        mediaIds: [],
        providerAccountIds: [accountOne, accountOne],
        scheduledAt: new Date('2026-09-01T10:00:00.000Z'),
      }),
    ).rejects.toThrow('Provider account targets must be unique');
  });
});

describe('media lifecycle', () => {
  it('derives metadata from bytes and marks storage failures for cleanup', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const storage = new FakeMediaStorage();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const stored = await storeMedia(db, storage, {
      workspaceId,
      userId,
      bytes: png,
      maxBytes: 100,
    });
    expect(stored).toMatchObject({ mimeType: 'image/png', byteSize: png.length });
    expect(stored.sha256).toBe(createHash('sha256').update(png).digest('hex'));
    storage.shouldFailPut = true;
    await expect(
      storeMedia(db, storage, { workspaceId, userId, bytes: png, maxBytes: 100 }),
    ).rejects.toThrow('Storage unavailable');
    const states = await database.query<{ state: string }>(
      'SELECT state FROM media_objects ORDER BY created_at',
    );
    expect(states.rows.map((row) => row.state).sort()).toEqual(['deleted', 'ready']);
  });

  it('reconciles stale temporary objects after an interrupted upload', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const storage = new FakeMediaStorage();
    const storageKey = `${workspaceId}/interrupted/object`;
    storage.objects.set(storageKey, Buffer.from('partial'));
    await database.exec(`
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state, created_at)
      VALUES ('00000000-0000-4000-8000-000000000209', '${workspaceId}', '${storageKey}', 'hash', 'image/png', 7, 'temporary', '2026-08-31T10:00:00Z')
    `);
    await expect(
      cleanupTemporaryMedia(db, storage, {
        workspaceId,
        olderThan: new Date('2026-08-31T11:00:00Z'),
      }),
    ).resolves.toBe(1);
    expect(storage.objects.has(storageKey)).toBe(false);
    const row = await database.query<{ state: string }>(
      "SELECT state FROM media_objects WHERE id = '00000000-0000-4000-8000-000000000209'",
    );
    expect(row.rows[0]?.state).toBe('deleted');
  });
});
