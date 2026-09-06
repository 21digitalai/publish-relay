import { readFile, readdir } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  XRemediationJournalRepository,
  loadRemediationSource,
} from '../src/modules/providers/x-remediation.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000801';
const jobId = '00000000-0000-4000-8000-000000000807';
const attemptId = '00000000-0000-4000-8000-000000000809';
const externalPostId = '2095509881344176536';
let database: PGlite;
let db: NodePgDatabase;

async function migrateDatabase(): Promise<void> {
  const directory = new URL('../migrations/', import.meta.url);
  const migrations = (await readdir(directory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const migration of migrations)
    await database.exec(await readFile(new URL(migration, directory), 'utf8'));
}

beforeEach(async () => {
  database = new PGlite();
  await migrateDatabase();
  await database.exec(`
    INSERT INTO workspaces (id, name, slug) VALUES ('${workspaceId}', 'Daily Viber', 'daily-viber');
    INSERT INTO users (id, email, password_hash, display_name) VALUES
      ('00000000-0000-4000-8000-000000000802', 'operator@example.test', 'redacted', 'Operator');
    SELECT set_config('app.workspace_id', '${workspaceId}', false);
    INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag) VALUES
      ('00000000-0000-4000-8000-000000000803', '${workspaceId}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
    INSERT INTO provider_connections (id, workspace_id, provider, credential_id) VALUES
      ('00000000-0000-4000-8000-000000000804', '${workspaceId}', 'x', '00000000-0000-4000-8000-000000000803');
    INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, display_name) VALUES
      ('00000000-0000-4000-8000-000000000805', '${workspaceId}', '00000000-0000-4000-8000-000000000804', 'daily-viber', 'TheDailyViber');
    INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES
      ('00000000-0000-4000-8000-000000000806', '${workspaceId}', '00000000-0000-4000-8000-000000000802');
    INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content) VALUES
      ('00000000-0000-4000-8000-000000000808', '${workspaceId}', '00000000-0000-4000-8000-000000000806', 1, '{"kind":"text","text":"  Corrected source text  "}');
    INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state) VALUES
      ('00000000-0000-4000-8000-000000000810', '${workspaceId}', 'daily-viber/image.png', '${'a'.repeat(64)}', 'image/png', 100, 'ready');
    INSERT INTO revision_media (workspace_id, revision_id, media_id, position) VALUES
      ('${workspaceId}', '00000000-0000-4000-8000-000000000808', '00000000-0000-4000-8000-000000000810', 0);
    INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at, state) VALUES
      ('${jobId}', '${workspaceId}', '00000000-0000-4000-8000-000000000806', '00000000-0000-4000-8000-000000000808', '00000000-0000-4000-8000-000000000805', now(), 'published');
    INSERT INTO publication_attempts (id, workspace_id, job_id, attempt_number, idempotency_key, request_fingerprint, started_at, finished_at, outcome, external_post_id) VALUES
      ('${attemptId}', '${workspaceId}', '${jobId}', 1, 'remediation-source', 'fingerprint', now(), now(), 'published', '${externalPostId}');
  `);
  db = drizzle(database) as unknown as NodePgDatabase;
});

afterEach(async () => database.close());

describe('X remediation PostgreSQL repository', () => {
  it('loads the immutable source and replays every journal transition idempotently', async () => {
    const source = await loadRemediationSource(db, workspaceId, jobId, externalPostId);
    expect(source).toMatchObject({
      jobId,
      attemptId,
      externalPostId,
      text: '  Corrected source text  ',
      media: [{ id: '00000000-0000-4000-8000-000000000810', sha256: 'a'.repeat(64) }],
    });

    const repository = new XRemediationJournalRepository(db, workspaceId);
    const prepared = await repository.prepare({
      phase: 'prepared',
      source,
      contentHash: 'source-hash',
    });
    expect(await repository.prepare(prepared)).toEqual(prepared);
    expect((await repository.markDeleteStarted(jobId)).phase).toBe('delete_started');
    expect((await repository.markDeleteStarted(jobId)).phase).toBe('delete_started');
    expect((await repository.markDeleted(jobId)).phase).toBe('deleted');
    expect((await repository.markDeleted(jobId)).phase).toBe('deleted');
    const replacement = {
      jobId: '00000000-0000-4000-8000-000000000811',
      attemptId: '00000000-0000-4000-8000-000000000812',
      externalPostId: 'replacement-post',
      externalUrl: 'https://x.com/TheDailyViber/status/replacement-post',
    };
    expect((await repository.markReplacementStarted(jobId)).phase).toBe('replacement_started');
    expect((await repository.markReplacementStarted(jobId)).phase).toBe('replacement_started');
    expect((await repository.markReplaced(jobId, replacement)).phase).toBe('replaced');
    expect((await repository.markReplaced(jobId, replacement)).replacementExternalPostId).toBe(
      'replacement-post',
    );
    expect((await repository.markVerified(jobId)).phase).toBe('verified');
    expect((await repository.markVerified(jobId)).phase).toBe('verified');
  });
});
