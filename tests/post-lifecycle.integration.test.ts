import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupTemporaryMedia, storeMedia } from '../src/modules/content/media.service.js';
import type { MediaStorage } from '../src/modules/content/media-storage.js';
import { createPost, editPost } from '../src/modules/content/post.service.js';
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

describe('post revision lifecycle', () => {
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
