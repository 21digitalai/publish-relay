import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupTemporaryMedia, storeMedia } from '../src/modules/content/media.service.js';
import {
  cleanupRetainedMedia,
  createFixedMediaRetentionPolicy,
  deleteUnattachedMedia,
  evaluateMediaRetention,
} from '../src/modules/content/media-retention.service.js';
import { runMediaRetentionCycle } from '../src/modules/content/media-retention.worker.js';
import type { MediaStorage } from '../src/modules/content/media-storage.js';
import { createPost, editPost, reschedulePost } from '../src/modules/content/post.service.js';
import type { ActionPolicy } from '../src/modules/policy/action-policy.js';
import { claimDueJobs } from '../src/modules/scheduler/job.repository.js';
import {
  cleanupExpiredStaging,
  cleanupJobStaging,
  type ProviderStagingStorage,
} from '../src/modules/content/provider-staging.service.js';
import {
  stageXMedia,
  type XMediaSource,
  type XMediaUploadClient,
} from '../src/modules/providers/x-media-staging.service.js';

const migrations = [
  '0000_identity_tenancy.sql',
  '0001_solid_spiral.sql',
  '0002_busy_mantis.sql',
  '0003_many_marvel_boy.sql',
  '0004_easy_doctor_spectrum.sql',
  '0005_round_thunderball.sql',
  '0006_enforce_content_workspace_foreign_keys.sql',
  '0007_add_scheduler_attempt_ledger.sql',
  '0008_handy_shen.sql',
  '0014_great_lethal_legion.sql',
  '0015_talented_alex_power.sql',
  '0016_common_barracuda.sql',
  '0017_dark_whizzer.sql',
  '0018_membership_identity_scope.sql',
  '0019_media_retention_lifecycle.sql',
  '0022_truthful_post_actors.sql',
  '0024_mp4_media_metadata.sql',
  '0025_lucky_legion.sql',
  '0026_parallel_human_cannonball.sql',
  '0027_overjoyed_dark_beast.sql',
  '0046_linkedin_connection_expiry.sql',
  '0047_linkedin_member_connections.sql',
  '0048_meta_effective_payload.sql',
];
const workspaceId = '00000000-0000-4000-8000-000000000201';
const userId = '00000000-0000-4000-8000-000000000202';
const accountOne = '00000000-0000-4000-8000-000000000203';
const accountTwo = '00000000-0000-4000-8000-000000000204';
let database: PGlite;

class FakeMediaStorage implements MediaStorage {
  readonly objects = new Map<string, Buffer>();
  shouldFailPut = false;
  shouldFailDelete = false;
  shouldReturnUnexpectedKey = false;

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
    return Promise.resolve({
      storageKey: this.shouldReturnUnexpectedKey ? `${storageKey}-wrong` : storageKey,
    });
  }

  delete(storageKey: string): Promise<void> {
    if (this.shouldFailDelete) return Promise.reject(new Error('Storage deletion unavailable'));
    this.objects.delete(storageKey);
    return Promise.resolve();
  }

  read(storageKey: string): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.objects.get(storageKey) ?? []));
  }
}

class FakeProviderStagingStorage implements ProviderStagingStorage {
  readonly references = new Set<string>();
  shouldFail = false;

  delete(providerReference: string): Promise<void> {
    if (this.shouldFail) return Promise.reject(new Error('Provider cleanup unavailable'));
    this.references.delete(providerReference);
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

describe('media retention lifecycle', () => {
  it('retries abandoned upload deletion after storage failure and refuses attached media', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const storage = new FakeMediaStorage();
    const freeMedia = '00000000-0000-4000-8000-000000000219';
    const attachedMedia = '00000000-0000-4000-8000-000000000220';
    const postId = '00000000-0000-4000-8000-000000000221';
    const revisionId = '00000000-0000-4000-8000-000000000222';
    await database.exec(`
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
        VALUES ('${freeMedia}', '${workspaceId}', 'abandoned-key', 'free', 'image/png', 11, 'ready'),
               ('${attachedMedia}', '${workspaceId}', 'attached-key', 'used', 'image/png', 13, 'ready');
      INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ('${postId}', '${workspaceId}', '${userId}');
      INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
        VALUES ('${revisionId}', '${workspaceId}', '${postId}', 1, '{"kind":"video","text":""}');
      INSERT INTO revision_media (workspace_id, revision_id, media_id, position)
        VALUES ('${workspaceId}', '${revisionId}', '${attachedMedia}', 0);
    `);
    storage.objects.set('abandoned-key', Buffer.from('bytes'));
    storage.shouldFailDelete = true;
    await expect(
      deleteUnattachedMedia(db, storage, { workspaceId, mediaId: freeMedia }),
    ).rejects.toThrow();
    expect(
      (
        await database.query<{ state: string }>(
          `SELECT state FROM media_objects WHERE id = '${freeMedia}'`,
        )
      ).rows[0]?.state,
    ).toBe('cleanup_failed');
    storage.shouldFailDelete = false;
    await expect(
      deleteUnattachedMedia(db, storage, { workspaceId, mediaId: freeMedia }),
    ).resolves.toBe(true);
    await expect(
      deleteUnattachedMedia(db, storage, { workspaceId, mediaId: freeMedia }),
    ).resolves.toBe(true);
    await expect(
      deleteUnattachedMedia(db, storage, { workspaceId, mediaId: attachedMedia }),
    ).resolves.toBe(false);
    await expect(
      deleteUnattachedMedia(db, storage, { workspaceId, mediaId: accountOne }),
    ).resolves.toBe(false);
  });

  it('retains referenced bytes, tombstones confirmed deletion, and replays cleanup safely', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const storage = new FakeMediaStorage();
    const freeMedia = '00000000-0000-4000-8000-000000000211';
    const usedMedia = '00000000-0000-4000-8000-000000000212';
    const postId = '00000000-0000-4000-8000-000000000213';
    const revisionId = '00000000-0000-4000-8000-000000000214';
    await database.exec(`
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state, retained_at)
        VALUES ('${freeMedia}', '${workspaceId}', 'free-key', 'free-hash', 'image/png', 11, 'ready', '2026-08-01'),
               ('${usedMedia}', '${workspaceId}', 'used-key', 'used-hash', 'image/png', 13, 'ready', '2026-08-01');
      INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ('${postId}', '${workspaceId}', '${userId}');
      INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
        VALUES ('${revisionId}', '${workspaceId}', '${postId}', 1, '{"type":"text","text":"retained"}');
      INSERT INTO revision_media (workspace_id, revision_id, media_id, position)
        VALUES ('${workspaceId}', '${revisionId}', '${usedMedia}', 0);
      INSERT INTO publication_jobs (workspace_id, post_id, revision_id, provider_account_id, scheduled_at, reconciliation_required)
        VALUES ('${workspaceId}', '${postId}', '${revisionId}', '${accountOne}', now(), true);
    `);
    storage.objects.set('free-key', Buffer.from('bytes'));
    const policy = createFixedMediaRetentionPolicy(0);
    await expect(
      evaluateMediaRetention(db, { workspaceId, now: new Date('2026-09-02'), policy }),
    ).resolves.toBe(1);
    await expect(
      cleanupRetainedMedia(db, storage, {
        workspaceId,
        now: new Date('2026-09-02'),
        retryDelayMs: 1000,
        staleClaimBefore: new Date('2026-09-01'),
      }),
    ).resolves.toEqual({ deleted: 1, failed: 0 });
    await expect(
      cleanupRetainedMedia(db, storage, {
        workspaceId,
        now: new Date('2026-09-03'),
        retryDelayMs: 1000,
        staleClaimBefore: new Date('2026-09-02'),
      }),
    ).resolves.toEqual({ deleted: 0, failed: 0 });
    const rows = await database.query<{
      id: string;
      state: string;
      deleted_at: Date | null;
      byte_size: number;
      sha256: string;
    }>('SELECT id, state, deleted_at, byte_size, sha256 FROM media_objects ORDER BY id');
    expect(rows.rows).toEqual([
      expect.objectContaining({
        id: freeMedia,
        state: 'deleted',
        byte_size: 11,
        sha256: 'free-hash',
      }),
      expect.objectContaining({ id: usedMedia, state: 'ready', deleted_at: null }),
    ]);
  });

  it('keeps storage failures retryable and recovers stale deleting claims', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const storage = new FakeMediaStorage();
    const mediaId = '00000000-0000-4000-8000-000000000215';
    await database.exec(`INSERT INTO media_objects
      (id, workspace_id, storage_key, sha256, mime_type, byte_size, state, cleanup_eligible_at)
      VALUES ('${mediaId}', '${workspaceId}', 'retry-key', 'retry-hash', 'image/png', 17, 'deleting', '2026-08-01')`);
    storage.shouldFailDelete = true;
    await expect(
      cleanupRetainedMedia(db, storage, {
        workspaceId,
        now: new Date('2026-09-02'),
        retryDelayMs: 1000,
        staleClaimBefore: new Date('2026-09-01'),
      }),
    ).resolves.toEqual({ deleted: 0, failed: 1 });
    storage.shouldFailDelete = false;
    await expect(
      cleanupRetainedMedia(db, storage, {
        workspaceId,
        now: new Date('2026-09-03'),
        retryDelayMs: 1000,
        staleClaimBefore: new Date('2026-09-02'),
      }),
    ).resolves.toEqual({ deleted: 1, failed: 0 });
    const row = await database.query<{ state: string; deletion_attempts: number }>(
      `SELECT state, deletion_attempts FROM media_objects WHERE id = '${mediaId}'`,
    );
    expect(row.rows[0]).toEqual({ state: 'deleted', deletion_attempts: 2 });
  });

  it('revives eligible media when a new scheduled job starts requiring it', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const storage = new FakeMediaStorage();
    const mediaId = '00000000-0000-4000-8000-000000000216';
    await database.exec(`INSERT INTO media_objects
      (id, workspace_id, storage_key, sha256, mime_type, byte_size, state, retained_at, cleanup_eligible_at)
      VALUES ('${mediaId}', '${workspaceId}', 'revived-key', 'revived-hash', 'image/png', 19,
        'cleanup_eligible', '2026-08-01', '2026-09-01')`);
    storage.objects.set('revived-key', Buffer.from('retained'));
    await createPost(db, {
      workspaceId,
      userId,
      content: { type: 'text', text: 'Use retained media' },
      mediaIds: [mediaId],
      providerAccountIds: [accountOne],
      scheduledAt: new Date('2026-09-03T10:00:00Z'),
    });
    await expect(
      cleanupRetainedMedia(db, storage, {
        workspaceId,
        now: new Date('2026-09-02'),
        retryDelayMs: 1000,
        staleClaimBefore: new Date('2026-09-01'),
      }),
    ).resolves.toEqual({ deleted: 0, failed: 0 });
    const row = await database.query<{ state: string; cleanup_eligible_at: Date | null }>(
      `SELECT state, cleanup_eligible_at FROM media_objects WHERE id = '${mediaId}'`,
    );
    expect(row.rows[0]).toEqual({ state: 'ready', cleanup_eligible_at: null });
    expect(storage.objects.has('revived-key')).toBe(true);
  });

  it('serializes concurrent scheduling against cleanup without deleting required bytes', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const storage = new FakeMediaStorage();
    const mediaId = '00000000-0000-4000-8000-000000000218';
    await database.exec(`INSERT INTO media_objects
      (id, workspace_id, storage_key, sha256, mime_type, byte_size, state, retained_at, cleanup_eligible_at)
      VALUES ('${mediaId}', '${workspaceId}', 'race-key', 'race-hash', 'image/png', 29,
        'cleanup_eligible', '2026-08-01', '2026-09-01')`);
    storage.objects.set('race-key', Buffer.from('race'));
    await Promise.allSettled([
      createPost(db, {
        workspaceId,
        userId,
        content: { type: 'text', text: 'Concurrent media use' },
        mediaIds: [mediaId],
        providerAccountIds: [accountOne],
        scheduledAt: new Date('2026-09-03T10:00:00Z'),
      }),
      cleanupRetainedMedia(db, storage, {
        workspaceId,
        now: new Date('2026-09-02'),
        retryDelayMs: 1000,
        staleClaimBefore: new Date('2026-09-01'),
      }),
    ]);
    const result = await database.query<{ state: string; active_references: number }>(`
      SELECT media.state,
        (SELECT count(*)::int FROM revision_media rm
          JOIN publication_jobs job ON job.revision_id = rm.revision_id
          WHERE rm.media_id = media.id AND job.state = 'scheduled') active_references
      FROM media_objects media WHERE media.id = '${mediaId}'
    `);
    expect(result.rows[0]?.state === 'deleted' && result.rows[0].active_references > 0).toBe(false);
  });

  it('runs a bounded worker cycle and reports cleanup outcomes', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const storage = new FakeMediaStorage();
    const mediaId = '00000000-0000-4000-8000-000000000217';
    await database.exec(`INSERT INTO media_objects
      (id, workspace_id, storage_key, sha256, mime_type, byte_size, state, retained_at)
      VALUES ('${mediaId}', '${workspaceId}', 'worker-key', 'worker-hash', 'image/png', 23,
        'ready', '2026-08-01')`);
    storage.objects.set('worker-key', Buffer.from('worker'));
    await expect(
      runMediaRetentionCycle(
        db,
        storage,
        createFixedMediaRetentionPolicy(0),
        {
          batchSize: 10,
          retryDelayMs: 1000,
          staleClaimMs: 60_000,
        },
        new Date('2026-09-02'),
      ),
    ).resolves.toEqual({ workspaces: 1, eligible: 1, deleted: 1, failed: 0 });
  });
});

describe('post revision lifecycle', () => {
  it('evaluates policy exactly once and leaves no post artifacts when denied', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    let evaluations = 0;
    const policy: ActionPolicy = {
      evaluate() {
        evaluations += 1;
        return Promise.resolve({
          allowed: false as const,
          code: 'action_not_allowed',
          reason: 'Denied for test',
        });
      },
    };
    await expect(
      createPost(
        db,
        {
          workspaceId,
          userId,
          content: { type: 'text', text: 'Denied' },
          mediaIds: [],
          providerAccountIds: [accountOne],
          scheduledAt: new Date('2026-09-01T10:00:00Z'),
        },
        policy,
      ),
    ).rejects.toMatchObject({ code: 'action_not_allowed' });
    expect(evaluations).toBe(1);
    const rows = await database.query('SELECT id FROM posts');
    expect(rows.rows).toHaveLength(0);
  });
  it('denies revise and reschedule exactly once without revision or job residue', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const created = await createPost(db, {
      workspaceId,
      userId,
      content: { type: 'text', text: 'Original' },
      mediaIds: [],
      providerAccountIds: [accountOne],
      scheduledAt: new Date('2026-09-01T10:00:00Z'),
    });
    const actions: string[] = [];
    const policy: ActionPolicy = {
      evaluate(context) {
        actions.push(context.action);
        return Promise.resolve({ allowed: false, code: 'action_not_allowed', reason: 'Denied' });
      },
    };
    await expect(
      editPost(
        db,
        {
          workspaceId,
          userId,
          postId: created.postId,
          content: { type: 'text', text: 'Rejected revision' },
          mediaIds: [],
          providerAccountIds: [accountOne],
          scheduledAt: new Date('2026-09-01T11:00:00Z'),
        },
        policy,
      ),
    ).rejects.toMatchObject({ code: 'action_not_allowed' });
    await expect(
      reschedulePost(
        db,
        {
          workspaceId,
          userId,
          postId: created.postId,
          scheduledAt: new Date('2026-09-01T12:00:00Z'),
        },
        policy,
      ),
    ).rejects.toMatchObject({ code: 'action_not_allowed' });
    expect(actions).toEqual(['publication.revise', 'publication.reschedule']);
    const counts = await database.query<{ revisions: number; jobs: number }>(`select
      (select count(*)::int from post_revisions) revisions,
      (select count(*)::int from publication_jobs) jobs`);
    expect(counts.rows[0]).toEqual({ revisions: 1, jobs: 1 });
  });
  it('rejects cross-workspace content graph references at the database boundary', async () => {
    const otherWorkspaceId = '00000000-0000-4000-8000-000000000210';
    const otherPostId = '00000000-0000-4000-8000-000000000211';
    const otherRevisionId = '00000000-0000-4000-8000-000000000212';
    const otherMediaId = '00000000-0000-4000-8000-000000000213';
    const otherAccountId = '00000000-0000-4000-8000-000000000214';
    const otherJobId = '00000000-0000-4000-8000-000000000215';

    await database.exec(`
      INSERT INTO workspaces (id, name, slug) VALUES ('${otherWorkspaceId}', 'Other Workspace', 'other-workspace');
      SELECT set_config('app.workspace_id', '${otherWorkspaceId}', false);
      INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${otherWorkspaceId}', '${userId}', 'owner');
      INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
        VALUES ('00000000-0000-4000-8000-000000000216', '${otherWorkspaceId}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
      INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
        VALUES ('00000000-0000-4000-8000-000000000217', '${otherWorkspaceId}', 'fake', '00000000-0000-4000-8000-000000000216');
      INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, display_name)
        VALUES ('${otherAccountId}', '${otherWorkspaceId}', '00000000-0000-4000-8000-000000000217', 'other', 'Other');
      INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ('${otherPostId}', '${otherWorkspaceId}', '${userId}');
      INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
        VALUES ('${otherRevisionId}', '${otherWorkspaceId}', '${otherPostId}', 1, '{"type":"text","text":"Other"}');
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
        VALUES ('${otherMediaId}', '${otherWorkspaceId}', 'other/media', 'hash', 'image/png', 4, 'ready');
      INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at)
        VALUES ('${otherJobId}', '${otherWorkspaceId}', '${otherPostId}', '${otherRevisionId}', '${otherAccountId}', now());
      SELECT set_config('app.workspace_id', '${workspaceId}', false);
    `);

    await expect(
      database.exec(`INSERT INTO post_revisions (workspace_id, post_id, revision_number, content)
        VALUES ('${workspaceId}', '${otherPostId}', 2, '{"type":"text","text":"Invalid"}')`),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      database.exec(`INSERT INTO revision_media (workspace_id, revision_id, media_id, position)
        VALUES ('${workspaceId}', '${otherRevisionId}', '${otherMediaId}', 0)`),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      database.exec(`INSERT INTO publication_jobs (workspace_id, post_id, revision_id, provider_account_id, scheduled_at)
        VALUES ('${workspaceId}', '${otherPostId}', '${otherRevisionId}', '${otherAccountId}', now())`),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      database.exec(`INSERT INTO provider_staging_artifacts (workspace_id, job_id, media_id, provider_reference, expires_at)
        VALUES ('${workspaceId}', '${otherJobId}', '${otherMediaId}', 'invalid', now())`),
    ).rejects.toThrow(/foreign key/i);
  });

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

  it('reschedules the complete immutable revision without losing targets, media, or content shape', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const mediaId = '00000000-0000-4000-8000-000000000299';
    await database.exec(`INSERT INTO media_objects
      (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
      VALUES ('${mediaId}', '${workspaceId}', 'schedule/media', 'schedule-hash', 'image/png', 4, 'ready')`);
    const created = await createPost(db, {
      workspaceId,
      userId,
      content: { type: 'quote', quoteId: 'quote-1', text: 'Preserve every field' },
      mediaIds: [mediaId],
      providerAccountIds: [accountOne, accountTwo],
      scheduledAt: new Date('2026-09-01T10:00:00.000Z'),
    });
    const result = await reschedulePost(db, {
      workspaceId,
      postId: created.postId,
      scheduledAt: new Date('2026-09-02T11:30:00.000Z'),
      now: new Date('2026-09-01T09:00:00.000Z'),
    });
    expect(result.jobIds).toHaveLength(2);
    expect(result.supersededJobIds).toHaveLength(2);
    const revisions = await database.query<{
      content: Record<string, unknown>;
      media_count: number;
    }>(`
      SELECT r.content, count(rm.media_id)::int AS media_count
      FROM post_revisions r LEFT JOIN revision_media rm ON rm.revision_id = r.id
      WHERE r.post_id = '${created.postId}' GROUP BY r.id, r.revision_number ORDER BY r.revision_number
    `);
    expect(revisions.rows[1]).toEqual({
      content: { type: 'quote', quoteId: 'quote-1', text: 'Preserve every field' },
      media_count: 1,
    });
  });

  it('serializes schedule editing against a concurrent scheduler claim', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const dueAt = new Date('2026-09-01T10:00:00.000Z');
    const created = await createPost(db, {
      workspaceId,
      userId,
      content: { type: 'text', text: 'Publish exactly once' },
      mediaIds: [],
      providerAccountIds: [accountOne],
      scheduledAt: dueAt,
    });

    const [rescheduleResult, claimResult] = await Promise.allSettled([
      reschedulePost(db, {
        workspaceId,
        postId: created.postId,
        scheduledAt: new Date('2026-09-02T10:00:00.000Z'),
        now: dueAt,
      }),
      claimDueJobs(db, { workerId: 'race-worker', now: dueAt, leaseMs: 30_000, limit: 1 }),
    ]);
    const jobs = await database.query<{ state: string; count: number }>(`
      SELECT state, count(*)::int AS count
      FROM publication_jobs WHERE post_id = '${created.postId}' GROUP BY state
    `);
    const counts = Object.fromEntries(jobs.rows.map((row) => [row.state, row.count]));

    expect((counts.leased ?? 0) > 0 && (counts.scheduled ?? 0) > 0).toBe(false);
    if (claimResult.status === 'fulfilled' && claimResult.value.length === 1) {
      expect(rescheduleResult.status).toBe('rejected');
      expect(counts).toEqual({ leased: 1 });
    } else {
      expect(rescheduleResult.status).toBe('fulfilled');
      expect(counts).toEqual({ scheduled: 1, superseded: 1 });
    }
  });

  it('rejects foreign workspace account and media targets atomically before persistence', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const otherWorkspaceId = '00000000-0000-4000-8000-000000000220';
    const otherAccountId = '00000000-0000-4000-8000-000000000221';
    const otherMediaId = '00000000-0000-4000-8000-000000000222';
    await database.exec(`
      INSERT INTO workspaces (id, name, slug) VALUES ('${otherWorkspaceId}', 'Foreign Workspace', 'foreign-workspace');
      SELECT set_config('app.workspace_id', '${otherWorkspaceId}', false);
      INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
        VALUES ('00000000-0000-4000-8000-000000000223', '${otherWorkspaceId}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
      INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
        VALUES ('00000000-0000-4000-8000-000000000224', '${otherWorkspaceId}', 'fake', '00000000-0000-4000-8000-000000000223');
      INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, display_name)
        VALUES ('${otherAccountId}', '${otherWorkspaceId}', '00000000-0000-4000-8000-000000000224', 'foreign', 'Foreign');
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
        VALUES ('${otherMediaId}', '${otherWorkspaceId}', 'foreign/media', 'hash', 'image/png', 4, 'ready');
      SELECT set_config('app.workspace_id', '${workspaceId}', false);
    `);
    const baseInput = {
      workspaceId,
      userId,
      content: { type: 'text', text: 'Invalid targets' },
      scheduledAt: new Date('2026-09-01T10:00:00Z'),
    };
    await expect(
      createPost(db, { ...baseInput, mediaIds: [], providerAccountIds: [otherAccountId] }),
    ).rejects.toThrow('provider accounts do not belong');
    await expect(
      createPost(db, { ...baseInput, mediaIds: [otherMediaId], providerAccountIds: [accountOne] }),
    ).rejects.toThrow('media objects do not belong');
    const counts = await database.query<{ posts: number; revisions: number; jobs: number }>(`
      SELECT (SELECT count(*)::int FROM posts) AS posts,
             (SELECT count(*)::int FROM post_revisions) AS revisions,
             (SELECT count(*)::int FROM publication_jobs) AS jobs
    `);
    expect(counts.rows[0]).toEqual({ posts: 0, revisions: 0, jobs: 0 });
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
  it('denies ingest before reserving database or storage artifacts', async () => {
    const storage = new FakeMediaStorage();
    const db = drizzle(database) as unknown as NodePgDatabase;
    const policy: ActionPolicy = {
      evaluate() {
        return Promise.resolve({
          allowed: false as const,
          code: 'action_not_allowed',
          reason: 'Denied for test',
        });
      },
    };
    await expect(
      storeMedia(
        db,
        storage,
        {
          workspaceId,
          userId,
          bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          maxBytes: 1024,
        },
        policy,
      ),
    ).rejects.toMatchObject({ code: 'action_not_allowed' });
    expect(storage.objects.size).toBe(0);
    const rows = await database.query('SELECT id FROM media_objects');
    expect(rows.rows).toHaveLength(0);
  });
  it('rejects empty, unsupported, and oversized media before reserving storage', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const storage = new FakeMediaStorage();
    await expect(
      storeMedia(db, storage, { workspaceId, userId, bytes: Buffer.alloc(0), maxBytes: 1024 }),
    ).rejects.toThrow('Media content is empty');
    await expect(
      storeMedia(db, storage, {
        workspaceId,
        userId,
        bytes: Buffer.from('not-media'),
        maxBytes: 1024,
      }),
    ).rejects.toThrow('Unsupported media content');
    await expect(
      storeMedia(db, storage, {
        workspaceId,
        userId,
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        maxBytes: 4,
      }),
    ).rejects.toThrow('Media exceeds the configured size limit');
    const count = await database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM media_objects',
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  it('retains cleanup ownership when compensating storage deletion fails', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const storage = new FakeMediaStorage();
    storage.shouldFailDelete = true;
    storage.shouldReturnUnexpectedKey = true;
    await expect(
      storeMedia(db, storage, {
        workspaceId,
        userId,
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        maxBytes: 1024,
      }),
    ).rejects.toThrow('Storage returned an unexpected key');
    const states = await database.query<{ state: string }>('SELECT state FROM media_objects');
    expect(states.rows).toEqual([{ state: 'temporary' }]);
  });

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

  it('persists server-probed MP4 metadata and enforces video limits', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const storage = new FakeMediaStorage();
    const mp4 = Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const probe = {
      probeMp4: vi.fn().mockResolvedValue({
        container: 'mp4' as const,
        durationMs: 30_000,
        width: 1080,
        height: 1920,
        videoCodec: 'h264',
        audioCodec: 'aac',
      }),
    };
    const stored = await storeMedia(db, storage, {
      workspaceId,
      userId,
      bytes: mp4,
      maxBytes: 1024,
      probe,
      limits: { maxDurationMs: 60_000, maxWidth: 2160, maxHeight: 3840 },
    });
    expect(stored.metadata).toMatchObject({ durationMs: 30_000, width: 1080, height: 1920 });
    const row = await database.query<{ duration_ms: number; container: string }>(
      `SELECT duration_ms, container FROM media_objects WHERE id = '${stored.mediaId}'`,
    );
    expect(row.rows[0]).toEqual({ duration_ms: 30_000, container: 'mp4' });
    probe.probeMp4.mockResolvedValueOnce({
      container: 'mp4',
      durationMs: 61_000,
      width: 1080,
      height: 1920,
      videoCodec: 'h264',
      audioCodec: null,
    });
    await expect(
      storeMedia(db, storage, {
        workspaceId,
        userId,
        bytes: mp4,
        maxBytes: 1024,
        probe,
        limits: { maxDurationMs: 60_000, maxWidth: 2160, maxHeight: 3840 },
      }),
    ).rejects.toThrow('Media duration exceeds');
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

describe('provider staging cleanup', () => {
  it('cleans terminal jobs and leaves failed crash reconciliation retryable', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const mediaStorage = new FakeMediaStorage();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const media = await storeMedia(db, mediaStorage, {
      workspaceId,
      userId,
      bytes: png,
      maxBytes: 100,
    });
    const post = await createPost(db, {
      workspaceId,
      userId,
      content: { type: 'text', text: 'Staged post' },
      mediaIds: [media.mediaId],
      providerAccountIds: [accountOne],
      scheduledAt: new Date('2026-09-01T10:00:00Z'),
    });
    const jobId = post.jobIds[0];
    if (!jobId) throw new Error('Expected publication job');
    await database.exec(`
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
      VALUES ('00000000-0000-4000-8000-000000000219', '${workspaceId}', 'second/media', 'second-hash', 'image/png', 9, 'ready');
      INSERT INTO provider_staging_artifacts (workspace_id, job_id, media_id, provider_reference, expires_at) VALUES
      ('${workspaceId}', '${jobId}', '${media.mediaId}', 'provider-ok', '2026-08-31T12:00:00Z'),
      ('${workspaceId}', '${jobId}', '00000000-0000-4000-8000-000000000219', 'provider-retry', '2026-08-31T12:00:00Z')
    `);
    const staging = new FakeProviderStagingStorage();
    staging.references.add('provider-ok');
    staging.references.add('provider-retry');
    await expect(cleanupJobStaging(db, staging, { workspaceId, jobId })).resolves.toBe(0);
    await database.exec(`UPDATE publication_jobs SET state = 'dispatching' WHERE id = '${jobId}'`);
    await expect(cleanupJobStaging(db, staging, { workspaceId, jobId })).resolves.toBe(0);
    expect(staging.references.size).toBe(2);
    await database.exec(`UPDATE publication_jobs SET state = 'published' WHERE id = '${jobId}'`);
    await expect(cleanupJobStaging(db, staging, { workspaceId, jobId })).resolves.toBe(2);
    expect(staging.references.size).toBe(0);
    for (const state of ['failed', 'cancelled', 'superseded'] as const) {
      const reference = `provider-${state}`;
      await database.exec(`
        UPDATE publication_jobs SET state = '${state}' WHERE id = '${jobId}';
        INSERT INTO provider_staging_artifacts (workspace_id, job_id, media_id, provider_reference, expires_at)
        VALUES ('${workspaceId}', '${jobId}', '${media.mediaId}', '${reference}', '2026-08-31T12:00:00Z');
      `);
      staging.references.add(reference);
      await expect(cleanupJobStaging(db, staging, { workspaceId, jobId })).resolves.toBe(1);
      expect(staging.references.has(reference)).toBe(false);
    }
    await database.exec(`
      UPDATE provider_staging_artifacts SET deleted_at = NULL
      WHERE provider_reference = 'provider-retry'
    `);
    staging.references.add('provider-retry');
    staging.shouldFail = true;
    await expect(
      cleanupExpiredStaging(db, staging, {
        workspaceId,
        expiredBefore: new Date('2026-08-31T13:00:00Z'),
      }),
    ).rejects.toThrow('Provider cleanup unavailable');
    const retryable = await database.query<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM provider_staging_artifacts WHERE provider_reference = 'provider-retry'",
    );
    expect(retryable.rows[0]?.deleted_at).toBeNull();
  });
});

describe('X media staging', () => {
  it('resumes missing chunks and polls STATUS only after FINALIZE', async () => {
    const postId = '00000000-0000-4000-8000-000000000220';
    const revisionId = '00000000-0000-4000-8000-000000000221';
    const mediaId = '00000000-0000-4000-8000-000000000222';
    const jobId = '00000000-0000-4000-8000-000000000223';
    await database.exec(`
      INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ('${postId}', '${workspaceId}', '${userId}');
      INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
        VALUES ('${revisionId}', '${workspaceId}', '${postId}', 1, '{"type":"text","text":"Media"}');
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
        VALUES ('${mediaId}', '${workspaceId}', 'media/key', 'hash', 'image/png', 5, 'ready');
      INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at)
        VALUES ('${jobId}', '${workspaceId}', '${postId}', '${revisionId}', '${accountOne}', now());
    `);
    const calls: string[] = [];
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 1);
    const source: XMediaSource = {
      load: () => Promise.resolve({ bytes, mimeType: 'image/png' }),
    };
    const interruptedSegments = new Set<number>();
    let shouldInterruptFinalize = true;
    let isFinalized = false;
    const client: XMediaUploadClient = {
      init: () => {
        calls.push('INIT');
        return Promise.resolve({ mediaId: 'x-media-1', expiresAfterSeconds: 3600 });
      },
      append: (_mediaId, segment) => {
        if (isFinalized) return Promise.reject(new Error('APPEND after FINALIZE'));
        calls.push(`APPEND:${String(segment)}`);
        if (!interruptedSegments.has(segment)) {
          interruptedSegments.add(segment);
          return Promise.reject(new Error(`interrupted segment ${String(segment)}`));
        }
        return Promise.resolve();
      },
      finalize: () => {
        calls.push('FINALIZE');
        if (shouldInterruptFinalize) {
          shouldInterruptFinalize = false;
          return Promise.reject(new Error('interrupted before finalize'));
        }
        isFinalized = true;
        return Promise.resolve({ state: 'pending' as const });
      },
      status: () => {
        calls.push('STATUS');
        return Promise.resolve({
          state: isFinalized ? ('pending' as const) : ('not_finalized' as const),
        });
      },
      discard: () => Promise.resolve(),
    };
    const input = { workspaceId, jobId, mediaId, idempotencyKey: 'job-media-1' };
    const db = drizzle(database) as unknown as NodePgDatabase;

    await expect(stageXMedia(db, source, client, input)).rejects.toThrow('interrupted segment 0');
    await expect(stageXMedia(db, source, client, input)).rejects.toThrow('interrupted segment 1');
    await expect(stageXMedia(db, source, client, input)).rejects.toThrow(
      'interrupted before finalize',
    );
    await expect(stageXMedia(db, source, client, input)).resolves.toEqual({
      mediaId: 'x-media-1',
      state: 'pending',
    });
    await expect(stageXMedia(db, source, client, input)).resolves.toEqual({
      mediaId: 'x-media-1',
      state: 'pending',
    });
    expect(calls).toEqual([
      'INIT',
      'APPEND:0',
      'APPEND:0',
      'APPEND:1',
      'APPEND:1',
      'STATUS',
      'FINALIZE',
      'STATUS',
      'FINALIZE',
      'STATUS',
    ]);
    const artifacts = await database.query<{
      count: number;
      upload_phase: string;
      next_segment: number;
    }>(
      `SELECT count(*)::int AS count, max(upload_phase) AS upload_phase,
        max(next_segment)::int AS next_segment FROM provider_staging_artifacts`,
    );
    expect(artifacts.rows[0]?.count).toBe(1);
    expect(artifacts.rows[0]?.upload_phase).toBe('finalized');
    expect(artifacts.rows[0]?.next_segment).toBe(2);
  });

  it('rejects unsupported and oversized X media before INIT', async () => {
    const init = vi.fn(() => Promise.resolve({ mediaId: 'unused', expiresAfterSeconds: 1 }));
    const client: XMediaUploadClient = {
      init,
      append: () => Promise.resolve(),
      finalize: () => Promise.resolve({ state: 'succeeded' }),
      status: () => Promise.resolve({ state: 'succeeded' }),
      discard: () => Promise.resolve(),
    };
    const db = drizzle(database) as unknown as NodePgDatabase;
    const input = {
      workspaceId,
      jobId: '00000000-0000-4000-8000-000000000281',
      mediaId: '00000000-0000-4000-8000-000000000282',
      idempotencyKey: 'validation',
    };
    await expect(
      stageXMedia(
        db,
        { load: () => Promise.resolve({ bytes: Buffer.from('x'), mimeType: 'text/plain' }) },
        client,
        input,
      ),
    ).rejects.toThrow('unsupported');
    await expect(
      stageXMedia(
        db,
        {
          load: () =>
            Promise.resolve({
              bytes: Buffer.alloc(5 * 1024 * 1024 + 1),
              mimeType: 'image/png',
            }),
        },
        client,
        input,
      ),
    ).rejects.toThrow('exceeds');
    expect(init).not.toHaveBeenCalled();
  });

  it('reconciles provider success after finalized progress persistence fails', async () => {
    const postId = '00000000-0000-4000-8000-000000000290';
    const revisionId = '00000000-0000-4000-8000-000000000291';
    const mediaId = '00000000-0000-4000-8000-000000000292';
    const jobId = '00000000-0000-4000-8000-000000000293';
    await database.exec(`
      INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ('${postId}', '${workspaceId}', '${userId}');
      INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
        VALUES ('${revisionId}', '${workspaceId}', '${postId}', 1, '{"type":"text","text":"Media"}');
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
        VALUES ('${mediaId}', '${workspaceId}', 'media/reconcile', 'hash', 'image/png', 1, 'ready');
      INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at)
        VALUES ('${jobId}', '${workspaceId}', '${postId}', '${revisionId}', '${accountOne}', now());
      CREATE TEMP SEQUENCE fail_finalized_once;
      CREATE OR REPLACE FUNCTION fail_first_finalized_update() RETURNS trigger AS $$
      BEGIN
        IF NEW.upload_phase = 'finalized' AND nextval('fail_finalized_once') = 1 THEN
          RAISE EXCEPTION 'simulated finalized persistence failure';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_finalized_progress BEFORE UPDATE ON provider_staging_artifacts
        FOR EACH ROW EXECUTE FUNCTION fail_first_finalized_update();
    `);
    let isFinalized = false;
    const finalize = vi.fn(() => {
      isFinalized = true;
      return Promise.resolve({ state: 'pending' as const });
    });
    const client: XMediaUploadClient = {
      init: () => Promise.resolve({ mediaId: 'x-media-reconcile', expiresAfterSeconds: 3600 }),
      append: () => Promise.resolve(),
      finalize,
      status: () =>
        Promise.resolve({ state: isFinalized ? ('pending' as const) : ('not_finalized' as const) }),
      discard: () => Promise.resolve(),
    };
    const input = { workspaceId, jobId, mediaId, idempotencyKey: 'reconcile' };
    const db = drizzle(database) as unknown as NodePgDatabase;

    await expect(
      stageXMedia(
        db,
        { load: () => Promise.resolve({ bytes: Buffer.from('x'), mimeType: 'image/png' }) },
        client,
        input,
      ),
    ).rejects.toThrow('Failed query');
    await expect(
      stageXMedia(
        db,
        { load: () => Promise.resolve({ bytes: Buffer.from('x'), mimeType: 'image/png' }) },
        client,
        input,
      ),
    ).resolves.toEqual({ mediaId: 'x-media-reconcile', state: 'pending' });
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it('accepts a durably finalized static image when X omits processing status', async () => {
    const postId = '00000000-0000-4000-8000-0000000002a0';
    const revisionId = '00000000-0000-4000-8000-0000000002a1';
    const mediaId = '00000000-0000-4000-8000-0000000002a2';
    const jobId = '00000000-0000-4000-8000-0000000002a3';
    await database.exec(`
      INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ('${postId}', '${workspaceId}', '${userId}');
      INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
        VALUES ('${revisionId}', '${workspaceId}', '${postId}', 1, '{"type":"text","text":"Media"}');
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
        VALUES ('${mediaId}', '${workspaceId}', 'media/static', 'hash', 'image/png', 1, 'ready');
      INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at)
        VALUES ('${jobId}', '${workspaceId}', '${postId}', '${revisionId}', '${accountOne}', now());
      INSERT INTO provider_staging_artifacts
        (workspace_id, job_id, media_id, provider_reference, expires_at, upload_phase, next_segment)
        VALUES ('${workspaceId}', '${jobId}', '${mediaId}', 'x-static-image', now() + interval '1 hour', 'finalized', 1);
    `);
    const client: XMediaUploadClient = {
      init: () => Promise.reject(new Error('unexpected INIT')),
      append: () => Promise.reject(new Error('unexpected APPEND')),
      finalize: () => Promise.reject(new Error('unexpected FINALIZE')),
      status: () => Promise.resolve({ state: 'not_finalized' as const }),
      discard: () => Promise.resolve(),
    };
    const db = drizzle(database) as unknown as NodePgDatabase;

    await expect(
      stageXMedia(db, { load: () => Promise.reject(new Error('unexpected media load')) }, client, {
        workspaceId,
        jobId,
        mediaId,
        idempotencyKey: 'static-image',
      }),
    ).resolves.toEqual({ mediaId: 'x-static-image', state: 'succeeded' });
  });

  it('replaces expired X staging only before any publish attempt', async () => {
    const postId = '00000000-0000-4000-8000-0000000002b1';
    const revisionId = '00000000-0000-4000-8000-0000000002b2';
    const mediaId = '00000000-0000-4000-8000-0000000002b3';
    const jobId = '00000000-0000-4000-8000-0000000002b4';
    await database.exec(`
      INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ('${postId}', '${workspaceId}', '${userId}');
      INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
        VALUES ('${revisionId}', '${workspaceId}', '${postId}', 1, '{"type":"text","text":"Media"}');
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
        VALUES ('${mediaId}', '${workspaceId}', 'media/expired', 'hash', 'image/png', 1, 'ready');
      INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at, state)
        VALUES ('${jobId}', '${workspaceId}', '${postId}', '${revisionId}', '${accountOne}', now(), 'leased');
      INSERT INTO provider_staging_artifacts
        (workspace_id, job_id, media_id, provider_reference, expires_at, upload_phase, next_segment)
        VALUES ('${workspaceId}', '${jobId}', '${mediaId}', 'expired-reference', now() - interval '1 hour', 'finalized', 1);
    `);
    const init = vi.fn(() =>
      Promise.resolve({ mediaId: 'fresh-reference', expiresAfterSeconds: 3600 }),
    );
    const client: XMediaUploadClient = {
      init,
      append: () => Promise.resolve(),
      finalize: () => Promise.resolve({ state: 'succeeded' }),
      status: (reference) =>
        reference === 'fresh-reference'
          ? Promise.resolve({ state: 'not_finalized' })
          : Promise.reject(new Error('expired reference must not be queried')),
      discard: () => Promise.resolve(),
    };
    const db = drizzle(database) as unknown as NodePgDatabase;
    await expect(
      stageXMedia(
        db,
        {
          load: () => Promise.resolve({ bytes: Buffer.from('x'), mimeType: 'image/png' }),
        },
        client,
        { workspaceId, jobId, mediaId, idempotencyKey: 'expired' },
      ),
    ).resolves.toEqual({ mediaId: 'fresh-reference', state: 'succeeded' });
    expect(init).toHaveBeenCalledTimes(1);
    const rows = await database.query<{ provider_reference: string; deleted_at: Date | null }>(
      `SELECT provider_reference, deleted_at FROM provider_staging_artifacts WHERE job_id = '${jobId}' ORDER BY created_at`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.deleted_at).not.toBeNull();
    expect(rows.rows[1]?.provider_reference).toBe('fresh-reference');
  });

  it('fails closed when an expired artifact cannot be retired', async () => {
    const postId = '00000000-0000-4000-8000-0000000002c1';
    const revisionId = '00000000-0000-4000-8000-0000000002c2';
    const mediaId = '00000000-0000-4000-8000-0000000002c3';
    const jobId = '00000000-0000-4000-8000-0000000002c4';
    await database.exec(`
      INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ('${postId}', '${workspaceId}', '${userId}');
      INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
        VALUES ('${revisionId}', '${workspaceId}', '${postId}', 1, '{"type":"text","text":"Media"}');
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
        VALUES ('${mediaId}', '${workspaceId}', 'media/race', 'hash', 'image/png', 1, 'ready');
      INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at, state, lease_owner)
        VALUES ('${jobId}', '${workspaceId}', '${postId}', '${revisionId}', '${accountOne}', now(), 'leased', 'worker-a');
      INSERT INTO provider_staging_artifacts
        (workspace_id, job_id, media_id, provider_reference, expires_at, upload_phase, next_segment)
        VALUES ('${workspaceId}', '${jobId}', '${mediaId}', 'expired-reference', now() - interval '1 hour', 'finalized', 1);
      CREATE OR REPLACE FUNCTION reject_expired_retirement() RETURNS trigger AS $$
      BEGIN
        RETURN NULL;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_expired_retirement BEFORE UPDATE ON provider_staging_artifacts
        FOR EACH ROW EXECUTE FUNCTION reject_expired_retirement();
    `);
    const init = vi.fn(() => Promise.reject(new Error('unexpected INIT')));
    const status = vi.fn(() => Promise.reject(new Error('stale reference queried')));
    const client: XMediaUploadClient = {
      init,
      status,
      append: () => Promise.resolve(),
      finalize: () => Promise.resolve({ state: 'succeeded' }),
      discard: () => Promise.resolve(),
    };
    await expect(
      stageXMedia(
        drizzle(database) as unknown as NodePgDatabase,
        { load: () => Promise.reject(new Error('unexpected media load')) },
        client,
        { workspaceId, jobId, mediaId, idempotencyKey: 'race', leaseOwner: 'worker-a' },
      ),
    ).rejects.toThrow('could not be retired');
    expect(init).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('does not recover expired X staging after a publication attempt exists', async () => {
    const postId = '00000000-0000-4000-8000-0000000002d1';
    const revisionId = '00000000-0000-4000-8000-0000000002d2';
    const mediaId = '00000000-0000-4000-8000-0000000002d3';
    const jobId = '00000000-0000-4000-8000-0000000002d4';
    await database.exec(`
      INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ('${postId}', '${workspaceId}', '${userId}');
      INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
        VALUES ('${revisionId}', '${workspaceId}', '${postId}', 1, '{"type":"text","text":"Media"}');
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
        VALUES ('${mediaId}', '${workspaceId}', 'media/attempt', 'hash', 'image/png', 1, 'ready');
      INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at, state)
        VALUES ('${jobId}', '${workspaceId}', '${postId}', '${revisionId}', '${accountOne}', now(), 'leased');
      INSERT INTO provider_staging_artifacts
        (workspace_id, job_id, media_id, provider_reference, expires_at, upload_phase, next_segment)
        VALUES ('${workspaceId}', '${jobId}', '${mediaId}', 'expired-reference', now() - interval '1 hour', 'finalized', 1);
      INSERT INTO publication_attempts
        (workspace_id, job_id, attempt_number, idempotency_key, request_fingerprint, started_at)
        VALUES ('${workspaceId}', '${jobId}', 1, 'prior-attempt', 'fingerprint', now());
    `);
    const init = vi.fn(() => Promise.reject(new Error('unexpected INIT')));
    const status = vi.fn(() => Promise.reject(new Error('stale reference queried')));
    const client: XMediaUploadClient = {
      init,
      status,
      append: () => Promise.resolve(),
      finalize: () => Promise.resolve({ state: 'succeeded' }),
      discard: () => Promise.resolve(),
    };
    await expect(
      stageXMedia(
        drizzle(database) as unknown as NodePgDatabase,
        { load: () => Promise.reject(new Error('unexpected media load')) },
        client,
        { workspaceId, jobId, mediaId, idempotencyKey: 'attempt' },
      ),
    ).rejects.toThrow('lease or attempt changed');
    expect(init).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('serializes concurrent staging against one canonical artifact', async () => {
    const postId = '00000000-0000-4000-8000-000000000294';
    const revisionId = '00000000-0000-4000-8000-000000000295';
    const mediaId = '00000000-0000-4000-8000-000000000296';
    const jobId = '00000000-0000-4000-8000-000000000297';
    await database.exec(`
      INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ('${postId}', '${workspaceId}', '${userId}');
      INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
        VALUES ('${revisionId}', '${workspaceId}', '${postId}', 1, '{"type":"text","text":"Media"}');
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
        VALUES ('${mediaId}', '${workspaceId}', 'media/concurrent', 'hash', 'image/png', 1, 'ready');
      INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at)
        VALUES ('${jobId}', '${workspaceId}', '${postId}', '${revisionId}', '${accountOne}', now());
    `);
    let initCount = 0;
    let isFinalized = false;
    const append = vi.fn(() => Promise.resolve());
    const finalize = vi.fn(() => {
      isFinalized = true;
      return Promise.resolve({ state: 'succeeded' as const });
    });
    const client: XMediaUploadClient = {
      init: () =>
        Promise.resolve({ mediaId: `x-media-${String(++initCount)}`, expiresAfterSeconds: 3600 }),
      append,
      finalize,
      status: () =>
        Promise.resolve({
          state: isFinalized ? ('succeeded' as const) : ('not_finalized' as const),
        }),
      discard: () => Promise.resolve(),
    };
    const source = {
      load: () => Promise.resolve({ bytes: Buffer.from('x'), mimeType: 'image/png' }),
    };
    const input = { workspaceId, jobId, mediaId, idempotencyKey: 'concurrent' };
    const db = drizzle(database) as unknown as NodePgDatabase;

    const results = await Promise.all([
      stageXMedia(db, source, client, input),
      stageXMedia(db, source, client, input),
    ]);
    expect(results[0].mediaId).toBe(results[1].mediaId);
    expect(append).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
  });
});
