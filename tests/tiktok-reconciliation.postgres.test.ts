import { createHash, randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { encryptCredential, type MasterKeyProvider } from '../src/modules/credentials/envelope.js';
import { TikTokHttpClient } from '../src/modules/providers/tiktok-http-client.js';
import { TikTokMediaGrantService } from '../src/modules/providers/tiktok-media-grant.service.js';
import {
  reconcileTikTokDirectPosts,
  revokeExpiredTerminalTikTokGrants,
} from '../src/modules/providers/tiktok-status-reconciliation.service.js';

const connectionString = process.env.POSTGRES_TIKTOK_RECONCILIATION_TEST_URL;
if (connectionString && !new URL(connectionString).pathname.endsWith('_test')) {
  throw new Error('TikTok PostgreSQL fixture requires a disposable _test database');
}
const keys: MasterKeyProvider = {
  currentVersion: () => 'fixture',
  getKey: () => Promise.resolve(Buffer.alloc(32, 7)),
};

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: { code: 'ok' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe.skipIf(!connectionString)('TikTok reconciliation on real PostgreSQL', () => {
  it('keeps forced RLS, claims persisted publish ID after connection restart, and atomically settles job and attempt', async () => {
    const admin = new pg.Pool({ connectionString });
    const workspaceId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const userId = randomUUID();
    const credentialId = randomUUID();
    const connectionId = randomUUID();
    const accountId = randomUUID();
    const mediaId = randomUUID();
    const postId = randomUUID();
    const revisionId = randomUUID();
    const jobId = randomUUID();
    const grantId = randomUUID();
    const token = {
      access_token: 'fixture-access',
      refresh_token: 'fixture-refresh',
      open_id: 'subject-one',
      scope: 'video.publish',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_expires_in: 86400,
    };
    const encrypted = await encryptCredential(Buffer.from(JSON.stringify(token)), keys);
    let worker: pg.Pool | undefined;
    try {
      await admin.query(
        'INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $5), ($3, $4, $6)',
        [
          workspaceId,
          'TikTok PG fixture',
          foreignWorkspaceId,
          'Foreign PG fixture',
          workspaceId,
          foreignWorkspaceId,
        ],
      );
      await admin.query(
        'INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)',
        [userId, `${userId}@example.test`, 'redacted', 'TikTok PG fixture'],
      );
      await admin.query(
        `INSERT INTO credentials
        (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          credentialId,
          workspaceId,
          encrypted.keyVersion,
          encrypted.wrappedKey,
          encrypted.wrappedKeyNonce,
          encrypted.wrappedKeyTag,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.tag,
        ],
      );
      await admin.query(
        `INSERT INTO provider_connections
        (id, workspace_id, provider, external_subject_id, credential_id, scopes, access_expires_at, refresh_expires_at)
        VALUES ($1,$2,'tiktok','subject-one',$3,'["video.publish"]',now() + interval '3 hours',now() + interval '1 day')`,
        [connectionId, workspaceId, credentialId],
      );
      await admin.query(
        `INSERT INTO provider_accounts
        (id, workspace_id, connection_id, provider_account_id, destination_provider, remote_account_id, display_name)
        VALUES ($1,$2,$3,'subject-one','tiktok','subject-one','One')`,
        [accountId, workspaceId, connectionId],
      );
      await admin.query(
        `INSERT INTO media_objects
        (id, workspace_id, storage_key, sha256, mime_type, byte_size, duration_ms,
         width, height, video_codec, container, state, retained_at)
        VALUES ($1,$2,'fixture.mp4',$3,'video/mp4',1024,30000,
          1080,1920,'h264','mp4','ready',now())`,
        [mediaId, workspaceId, 'a'.repeat(64)],
      );
      await admin.query(
        'INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ($1,$2,$3)',
        [postId, workspaceId, userId],
      );
      await admin.query(
        `INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
        VALUES ($1,$2,$3,1,'{}')`,
        [revisionId, workspaceId, postId],
      );
      await admin.query(
        `INSERT INTO publication_jobs
        (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at,
         state, attempt_number, reconciliation_required, lease_expires_at)
        VALUES ($1,$2,$3,$4,$5,now(),'accepted_pending',1,true,now() - interval '1 minute')`,
        [jobId, workspaceId, postId, revisionId, accountId],
      );
      await admin.query(
        `INSERT INTO provider_media_grants
        (id, workspace_id, account_id, media_id, token_hash, media_sha256, mime_type, byte_size, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,'video/mp4',1024,now() + interval '91 minutes')`,
        [
          grantId,
          workspaceId,
          accountId,
          mediaId,
          createHash('sha256').update(grantId).digest('hex'),
          'a'.repeat(64),
        ],
      );
      await admin.query(
        `INSERT INTO publication_attempts
        (workspace_id, job_id, attempt_number, idempotency_key, request_fingerprint,
         started_at, tiktok_init_phase, provider_request_id, tiktok_media_grant_id)
        VALUES ($1,$2,1,$3,$3,now(),'accepted_pending','publish-persisted',$4)`,
        [workspaceId, jobId, randomUUID(), grantId],
      );

      const web = await admin.connect();
      try {
        await web.query('BEGIN');
        await web.query('SET LOCAL ROLE publish_relay_web');
        await web.query("SELECT set_config('app.workspace_id', $1, true)", [foreignWorkspaceId]);
        for (const table of ['publication_jobs', 'publication_attempts', 'provider_media_grants']) {
          const hidden = await web.query(`SELECT id FROM ${table} WHERE workspace_id = $1`, [
            workspaceId,
          ]);
          expect(hidden.rows).toHaveLength(0);
        }
        await web.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        for (const table of ['publication_jobs', 'publication_attempts', 'provider_media_grants']) {
          const visible = await web.query(`SELECT id FROM ${table} WHERE workspace_id = $1`, [
            workspaceId,
          ]);
          expect(visible.rows).toHaveLength(1);
        }
      } finally {
        await web.query('ROLLBACK');
        web.release();
      }

      let status = 'PROCESSING_UPLOAD';
      const calls: string[] = [];
      const fetcher: typeof fetch = (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        return Promise.resolve(
          response(
            url.endsWith('/creator_info/query/')
              ? {
                  creator_username: 'one',
                  creator_nickname: 'One',
                  creator_avatar_url: 'https://example.test/avatar',
                  privacy_level_options: ['SELF_ONLY'],
                  comment_disabled: false,
                  duet_disabled: true,
                  stitch_disabled: true,
                  max_video_post_duration_sec: 120,
                }
              : {
                  status,
                  ...(status === 'PUBLISH_COMPLETE'
                    ? { publicaly_available_post_id: ['7333862123456789012'] }
                    : {}),
                },
          ),
        );
      };
      const openWorker = () =>
        new pg.Pool({ connectionString, options: '-c role=publish_relay_worker' });
      const runtime = (pool: pg.Pool) => {
        const database = drizzle(pool);
        return {
          database,
          keys,
          client: new TikTokHttpClient({
            clientKey: 'fixture',
            clientSecret: 'fixture',
            fetch: fetcher,
          }),
          grants: new TikTokMediaGrantService(database, Buffer.alloc(32, 8)),
          workerId: 'pg-worker',
          leaseMs: 60_000,
          publicOrigin: 'https://media.example.test',
          verifiedMediaOrigin: 'https://media.example.test',
        };
      };
      worker = openWorker();
      expect(
        (await worker.query<{ role: string }>('SELECT current_user AS role')).rows[0]?.role,
      ).toBe('publish_relay_worker');
      expect(await reconcileTikTokDirectPosts(runtime(worker))).toBe(1);
      const pending = await admin.query(
        'SELECT state, reconciliation_required FROM publication_jobs WHERE id = $1',
        [jobId],
      );
      expect(pending.rows[0]).toEqual({ state: 'accepted_pending', reconciliation_required: true });
      expect(
        await revokeExpiredTerminalTikTokGrants(
          drizzle(worker),
          new Date(Date.now() + 92 * 60_000),
        ),
      ).toBe(0);

      await worker.end(); // New connection pool has only durable PostgreSQL state, not prior runtime state.
      worker = openWorker();
      status = 'PUBLISH_COMPLETE';
      expect(await reconcileTikTokDirectPosts(runtime(worker), new Date(Date.now() + 61_000))).toBe(
        1,
      );
      const terminal = await admin.query(
        `SELECT job.state, job.reconciliation_required, attempt.outcome,
        attempt.provider_request_id, attempt.external_post_id, attempt.external_url, grant_row.revoked_at
        FROM publication_jobs job JOIN publication_attempts attempt ON attempt.job_id = job.id
        JOIN provider_media_grants grant_row ON grant_row.id = attempt.tiktok_media_grant_id
        WHERE job.id = $1`,
        [jobId],
      );
      expect(terminal.rows[0]).toEqual({
        state: 'published',
        reconciliation_required: false,
        outcome: 'published',
        provider_request_id: 'publish-persisted',
        external_post_id: '7333862123456789012',
        external_url: 'https://www.tiktok.com/@one/video/7333862123456789012',
        revoked_at: null,
      });
      expect(
        await revokeExpiredTerminalTikTokGrants(
          drizzle(worker),
          new Date(Date.now() + 92 * 60_000),
        ),
      ).toBe(1);
      expect(calls.filter((url) => url.endsWith('/publish/video/init/'))).toHaveLength(0);
    } finally {
      await worker?.end();
      // Use a disposable migrated test database. Immutable post revisions deliberately
      // prevent fixture teardown by DELETE; unique IDs isolate repeated runs.
      await admin.end();
    }
  });
});
