import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { getBrowserJobDetail } from '../src/modules/content/post-read.repository.js';

const connectionString = process.env.POSTGRES_POST_URL_TEST_URL;

describe.skipIf(!connectionString)('provider post URL on real PostgreSQL', () => {
  it('reads the migrated permalink through the tenant-scoped detail path', async () => {
    const pool = new pg.Pool({ connectionString });
    const client = await pool.connect();
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const userId = randomUUID();
    const credentialId = randomUUID();
    const connectionId = randomUUID();
    const accountId = randomUUID();
    const postId = randomUUID();
    const revisionId = randomUUID();
    const jobId = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)', [
        workspaceId,
        'URL Test',
        workspaceId,
      ]);
      await client.query(
        'INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)',
        [userId, `${userId}@example.test`, 'redacted', 'URL Test'],
      );
      await client.query(
        `INSERT INTO credentials
        (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
        VALUES ($1, $2, 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06')`,
        [credentialId, workspaceId],
      );
      await client.query(
        `INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
        VALUES ($1, $2, 'meta', $3)`,
        [connectionId, workspaceId, credentialId],
      );
      await client.query(
        `INSERT INTO provider_accounts
        (id, workspace_id, connection_id, provider_account_id, display_name, destination_provider, remote_account_id)
        VALUES ($1, $2, $3, 'page', 'Test Page', 'facebook_page', 'page')`,
        [accountId, workspaceId, connectionId],
      );
      await client.query(
        'INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ($1, $2, $3)',
        [postId, workspaceId, userId],
      );
      await client.query(
        `INSERT INTO post_revisions
        (id, workspace_id, post_id, revision_number, content)
        VALUES ($1, $2, $3, 1, '{"type":"text","text":"Due"}')`,
        [revisionId, workspaceId, postId],
      );
      await client.query(
        `INSERT INTO publication_jobs
        (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at, state, attempt_number, effective_payload)
        VALUES ($1, $2, $3, $4, $5, now(), 'published', 1,
          '{"schemaVersion":1,"destinationProvider":"facebook_page","kind":"single_image","message":"Due","mediaIds":[]}')`,
        [jobId, workspaceId, postId, revisionId, accountId],
      );
      await client.query(
        `INSERT INTO publication_attempts
        (workspace_id, job_id, attempt_number, idempotency_key, request_fingerprint,
         started_at, finished_at, outcome, external_post_id, external_url)
        VALUES ($1, $2, 1, $3, $3, now(), now(), 'published', 'page_123',
          'https://www.facebook.com/page/posts/123')`,
        [workspaceId, jobId, randomUUID()],
      );
      const detail = await getBrowserJobDetail(drizzle(client), workspaceId, jobId);
      expect(detail?.providerResult?.url).toBe('https://www.facebook.com/page/posts/123');
      expect(detail?.attempts[0]).not.toHaveProperty('externalUrl');
      await client.query('UPDATE publication_attempts SET external_url = NULL WHERE job_id = $1', [
        jobId,
      ]);
      const historicalDetail = await getBrowserJobDetail(drizzle(client), workspaceId, jobId);
      expect(historicalDetail?.providerResult?.url).toBe('https://www.facebook.com/page_123');
      expect(await getBrowserJobDetail(drizzle(client), otherWorkspaceId, jobId)).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  });
});
