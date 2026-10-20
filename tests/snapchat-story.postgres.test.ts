import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/providers/snapchat-credential.service.js', () => ({
  getFreshSnapchatToken: vi.fn(() => Promise.resolve({ access_token: 'fixture' })),
}));
vi.mock('../src/modules/providers/snapchat-story-upload.js', () => ({
  stageAndPostSnapchatStory: vi.fn(),
}));

import { loadSnapchatJob } from '../src/modules/providers/snapchat-dispatch-support.js';
import { dispatchDueSnapchatStories } from '../src/modules/providers/snapchat-story-dispatch.service.js';
import { stageAndPostSnapchatStory } from '../src/modules/providers/snapchat-story-upload.js';
import { resolveSnapchatStoryEvidence } from '../src/modules/providers/snapchat-story-resolution.service.js';
import { registerSnapchatStoryResolutionRoutes } from '../src/modules/providers/snapchat-story-resolution.routes.js';
import type { AuthService } from '../src/modules/identity/auth.service.js';

const connectionString = process.env.POSTGRES_SNAPCHAT_STORY_TEST_URL;

describe.skipIf(!connectionString)('Snapchat Story authority on real PostgreSQL', () => {
  it('reads only a tenant-owned, current owner-profile media job under forced RLS', async () => {
    const pool = new pg.Pool({ connectionString });
    const client = await pool.connect();
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const userId = randomUUID();
    const editorUserId = randomUUID();
    const credentialId = randomUUID();
    const connectionId = randomUUID();
    const accountId = randomUUID();
    const mediaId = randomUUID();
    const postId = randomUUID();
    const revisionId = randomUUID();
    const jobId = randomUUID();
    const profileId = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query(
        'insert into workspaces (id, name, slug) values ($1, $2, $3), ($4, $5, $6)',
        [workspaceId, 'Story', workspaceId, otherWorkspaceId, 'Other', otherWorkspaceId],
      );
      await client.query(
        'insert into users (id, email, password_hash, display_name) values ($1, $2, $3, $4)',
        [userId, `${userId}@example.test`, 'redacted', 'Story owner'],
      );
      await client.query(
        'insert into users (id, email, password_hash, display_name) values ($1, $2, $3, $4)',
        [editorUserId, `${editorUserId}@example.test`, 'redacted', 'Story editor'],
      );
      await client.query(
        'insert into memberships (workspace_id, user_id, role) values ($1, $2, $3), ($1, $4, $5)',
        [workspaceId, userId, 'owner', editorUserId, 'editor'],
      );
      await client.query(
        `insert into credentials (id, workspace_id, key_version, wrapped_key,
          wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
          values ($1, $2, 'fixture', '\\x01', '\\x01', '\\x01', '\\x01', '\\x01', '\\x01')`,
        [credentialId, workspaceId],
      );
      await client.query(
        `insert into provider_connections (id, workspace_id, provider,
          external_subject_id, credential_id) values ($1, $2, 'snapchat', $3, $4)`,
        [connectionId, workspaceId, profileId, credentialId],
      );
      await client.query(
        `insert into provider_accounts (id, workspace_id, connection_id, provider_account_id,
          destination_provider, remote_account_id, display_name)
          values ($1, $2, $3, $4, 'snapchat', $4, 'Story owner')`,
        [accountId, workspaceId, connectionId, profileId],
      );
      await client.query(
        `insert into media_objects (id, workspace_id, storage_key, sha256, mime_type,
          byte_size, duration_ms, width, height, video_codec, container, state)
          values ($1, $2, 'story.mp4', $3, 'video/mp4', 1024, 6000, 540, 960,
            'h264', 'mp4', 'ready')`,
        [mediaId, workspaceId, 'a'.repeat(64)],
      );
      await client.query(
        'insert into posts (id, workspace_id, created_by_user_id) values ($1, $2, $3)',
        [postId, workspaceId, userId],
      );
      await client.query(
        'insert into post_revisions (id, workspace_id, post_id, revision_number, content) values ($1, $2, $3, 1, $4)',
        [revisionId, workspaceId, postId, '{}'],
      );
      await client.query(
        'insert into revision_media (workspace_id, revision_id, media_id, position) values ($1, $2, $3, 0)',
        [workspaceId, revisionId, mediaId],
      );
      await client.query(
        `insert into publication_jobs (id, workspace_id, post_id, revision_id,
          provider_account_id, effective_payload, scheduled_at)
          values ($1, $2, $3, $4, $5, $6, now())`,
        [
          jobId,
          workspaceId,
          postId,
          revisionId,
          accountId,
          JSON.stringify({ schemaVersion: 1, kind: 'story_video', mediaId }),
        ],
      );
      await client.query('SET LOCAL ROLE publish_relay_web');
      const runtime = {
        database: drizzle(client),
        keys: {} as never,
        oauthClient: {} as never,
        client: {} as never,
        mediaStorage: { openVerifiedRange: vi.fn() } as never,
        workerId: 'postgres-story-fixture',
        leaseMs: 60_000,
      };
      expect((await loadSnapchatJob(runtime, workspaceId, jobId, 'story')).profileId).toBe(
        profileId,
      );
      await expect(loadSnapchatJob(runtime, otherWorkspaceId, jobId, 'story')).rejects.toThrow(
        'Snapchat owner profile or media is unavailable',
      );
      await client.query('RESET ROLE');
      await client.query('update provider_accounts set remote_account_id = $1 where id = $2', [
        randomUUID(),
        accountId,
      ]);
      await client.query('SET LOCAL ROLE publish_relay_web');
      await expect(loadSnapchatJob(runtime, workspaceId, jobId, 'story')).rejects.toThrow(
        'Snapchat owner profile or media is unavailable',
      );
      await client.query('RESET ROLE');
      await client.query('update provider_accounts set remote_account_id = $1 where id = $2', [
        profileId,
        accountId,
      ]);
      const requestId = randomUUID();
      vi.mocked(stageAndPostSnapchatStory).mockImplementationOnce(async (input) => {
        await input.onMediaCreated?.('remote-media');
        await input.onBeforeStoryPost?.();
        await input.onStoryPosted?.(requestId);
        return { mediaId: 'remote-media', requestId };
      });
      expect(await dispatchDueSnapchatStories(runtime, new Date(Date.now() + 1_000))).toBe(1);
      expect(
        (
          await client.query<{ state: string; reconciliation_required: boolean }>(
            'select state, reconciliation_required from publication_jobs where id = $1',
            [jobId],
          )
        ).rows[0],
      ).toEqual({ state: 'dispatching', reconciliation_required: true });
      expect(
        (
          await client.query<{ outcome: string; external_post_id: string | null }>(
            'select outcome, external_post_id from publication_attempts where job_id = $1',
            [jobId],
          )
        ).rows[0],
      ).toEqual({ outcome: 'unknown', external_post_id: null });
      const currentAttempt = (
        await client.query<{ id: string; provider_request_id: string }>(
          'select id, provider_request_id from publication_attempts where job_id = $1',
          [jobId],
        )
      ).rows[0];
      if (!currentAttempt) throw new Error('Story attempt fixture missing');
      const evidence = {
        outcome: 'published' as const,
        attemptId: currentAttempt.id,
        providerRequestId: currentAttempt.provider_request_id,
        source: 'provider_support' as const,
        reference: 'support-case-12345',
        storyId: 'story12345',
        permalink: 'https://www.snapchat.com/p/story12345',
      };
      const action = { workspaceId, userId, jobId, requestId: 'admin-resolution', evidence };
      await expect(resolveSnapchatStoryEvidence(runtime.database, action)).rejects.toThrow(
        'No verified Story correlation',
      );
      expect(
        (
          await client.query<{ state: string; reconciliation_required: boolean }>(
            'select state, reconciliation_required from publication_jobs where id = $1',
            [jobId],
          )
        ).rows[0],
      ).toEqual({ state: 'dispatching', reconciliation_required: true });
      expect(
        (await client.query('select 1 from audit_events where target_id = $1', [jobId])).rowCount,
      ).toBe(0);
      await client.query('RESET ROLE');
      const failedJobId = randomUUID();
      const failedAttemptId = randomUUID();
      await client.query(
        `insert into publication_jobs (id, workspace_id, post_id, revision_id,
        provider_account_id, effective_payload, scheduled_at, state, attempt_number,
        reconciliation_required) values ($1, $2, $3, $4, $5, $6, now(),
        'dispatching', 1, true)`,
        [
          failedJobId,
          workspaceId,
          postId,
          revisionId,
          accountId,
          JSON.stringify({ kind: 'story_video', mediaId }),
        ],
      );
      await client.query(
        `insert into publication_attempts (id, workspace_id, job_id,
        attempt_number, idempotency_key, request_fingerprint, started_at, outcome,
        provider_request_id, reconciliation_key) values ($1, $2, $3, 1, 'fixture-key',
        'fixture-fingerprint', now(), 'unknown', 'request-failed', $4)`,
        [failedAttemptId, workspaceId, failedJobId, `snapchat:story:${failedJobId}`],
      );
      await client.query('SET LOCAL ROLE publish_relay_web');
      const failedEvidence = {
        outcome: 'failed' as const,
        attemptId: failedAttemptId,
        providerRequestId: 'request-failed',
        source: 'provider_support' as const,
        reference: 'support-case-absence-9',
        finding: 'verified_absent' as const,
      };
      await expect(
        resolveSnapchatStoryEvidence(runtime.database, {
          ...action,
          jobId: failedJobId,
          evidence: failedEvidence,
          workspaceId: otherWorkspaceId,
        }),
      ).rejects.toThrow();
      await expect(
        resolveSnapchatStoryEvidence(runtime.database, {
          ...action,
          jobId: failedJobId,
          evidence: failedEvidence,
          userId: randomUUID(),
        }),
      ).rejects.toThrow();
      await expect(
        resolveSnapchatStoryEvidence(runtime.database, {
          ...action,
          jobId: failedJobId,
          evidence: { ...failedEvidence, attemptId: randomUUID() },
        }),
      ).rejects.toThrow('current attempt');
      const app = Fastify();
      await app.register(cookie);
      const auth = {
        authenticate: (tenant: string, token: string) =>
          Promise.resolve(
            tenant === workspaceId
              ? {
                  workspaceId,
                  userId: token === 'editor' ? editorUserId : userId,
                  role: token === 'editor' ? 'editor' : 'owner',
                }
              : { workspaceId: otherWorkspaceId, userId, role: 'owner' },
          ),
      } as unknown as AuthService;
      registerSnapchatStoryResolutionRoutes(app, { auth, database: runtime.database });
      const url = `/api/workflow/jobs/${jobId}/snapchat-story-resolution`;
      const headers = {
        cookie: `publish_relay_session=${workspaceId}.token; publish_relay_csrf=csrf`,
        'x-csrf-token': 'csrf',
      };
      expect((await app.inject({ method: 'POST', url, payload: evidence })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: evidence,
            headers: { cookie: headers.cookie },
          })
        ).statusCode,
      ).toBe(403);
      const routeBlocked = await app.inject({ method: 'POST', url, payload: evidence, headers });
      expect(routeBlocked.statusCode, routeBlocked.body).toBe(409);
      const failedUrl = `/api/workflow/jobs/${failedJobId}/snapchat-story-resolution`;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: failedUrl,
            payload: failedEvidence,
            headers: {
              ...headers,
              cookie: `publish_relay_session=${workspaceId}.editor; publish_relay_csrf=csrf`,
            },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: failedUrl,
            payload: failedEvidence,
            headers: {
              ...headers,
              cookie: `publish_relay_session=${otherWorkspaceId}.token; publish_relay_csrf=csrf`,
            },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: failedUrl,
            payload: { ...failedEvidence, attemptId: randomUUID() },
            headers,
          })
        ).statusCode,
      ).toBe(409);
      const resolved = await app.inject({
        method: 'POST',
        url: failedUrl,
        payload: failedEvidence,
        headers,
      });
      expect(resolved.statusCode, resolved.body).toBe(200);
      expect(resolved.json()).toMatchObject({ data: { outcome: 'failed', replayed: false } });
      const jobAfter = (
        await client.query<{
          state: string;
          reconciliation_required: boolean;
        }>('select state, reconciliation_required from publication_jobs where id = $1', [
          failedJobId,
        ])
      ).rows[0];
      expect(jobAfter).toEqual({
        state: 'failed',
        reconciliation_required: false,
      });
      const attemptAfter = (
        await client.query<{
          outcome: string;
          finished_at: Date;
          external_post_id: string | null;
          external_url: string | null;
        }>(
          'select outcome, finished_at, external_post_id, external_url from publication_attempts where id = $1',
          [failedAttemptId],
        )
      ).rows[0];
      expect(attemptAfter).toMatchObject({
        outcome: 'permanent',
        external_post_id: null,
        external_url: null,
      });
      expect(attemptAfter?.finished_at).toBeInstanceOf(Date);
      const audit = (
        await client.query<{
          actor_id: string;
          request_id: string;
          metadata: { actorId: string; resolvedAt: string; evidence: unknown };
        }>(
          "select actor_id, request_id, metadata from audit_events where target_id = $1 and action = 'snapchat_story.manual_resolution'",
          [failedJobId],
        )
      ).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actor_id).toBe(userId);
      expect(audit[0]?.request_id).toBeTruthy();
      expect(audit[0]?.metadata).toMatchObject({ actorId: userId, evidence: failedEvidence });
      expect(Date.parse(audit[0]?.metadata.resolvedAt ?? '')).toBeGreaterThan(0);
      const events = (
        await client.query<{
          from_state: string;
          to_state: string;
          reason: string;
          metadata: unknown;
        }>(
          "select from_state, to_state, reason, metadata from publication_job_events where job_id = $1 and reason = 'snapchat_story_manual_resolution'",
          [failedJobId],
        )
      ).rows;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        from_state: 'dispatching',
        to_state: 'failed',
        metadata: { actorId: userId, evidence: failedEvidence },
      });
      expect(
        (
          await app.inject({ method: 'POST', url: failedUrl, payload: failedEvidence, headers })
        ).json(),
      ).toMatchObject({ data: { outcome: 'failed', replayed: true } });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: failedUrl,
            payload: { ...failedEvidence, reference: 'other-case-98765' },
            headers,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await client.query(
            "select 1 from audit_events where target_id = $1 and action = 'snapchat_story.manual_resolution'",
            [failedJobId],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await client.query(
            "select 1 from publication_job_events where job_id = $1 and reason = 'snapchat_story_manual_resolution'",
            [failedJobId],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { ...evidence, permalink: 'https://evil.example/p/story12345' },
            headers,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await client.query<{ state: string; reconciliation_required: boolean }>(
            'select state, reconciliation_required from publication_jobs where id = $1',
            [jobId],
          )
        ).rows[0],
      ).toEqual({ state: 'dispatching', reconciliation_required: true });
      expect(
        (
          await client.query<{
            outcome: string;
            external_post_id: string | null;
            external_url: string | null;
          }>(
            'select outcome, external_post_id, external_url from publication_attempts where job_id = $1',
            [jobId],
          )
        ).rows[0],
      ).toEqual({ outcome: 'unknown', external_post_id: null, external_url: null });
      expect(
        (
          await client.query(
            "select 1 from audit_events where target_id = $1 and action = 'snapchat_story.manual_resolution'",
            [jobId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await client.query(
            "select 1 from publication_job_events where job_id = $1 and reason = 'snapchat_story_manual_resolution'",
            [jobId],
          )
        ).rowCount,
      ).toBe(0);
      await app.close();
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  });
});
