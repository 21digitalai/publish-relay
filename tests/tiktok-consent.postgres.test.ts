import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  getTikTokPublicationConsent,
  issueTikTokPublicationConsent,
  verifyTikTokPublicationConsent,
} from '../src/modules/providers/tiktok-consent.service.js';
import { scheduleTikTokDraft } from '../src/modules/providers/tiktok-schedule.service.js';
import {
  claimExactDueJob,
  recoverExpiredDispatches,
  startDispatchAttempt,
} from '../src/modules/scheduler/job.repository.js';
import { TikTokMediaGrantService } from '../src/modules/providers/tiktok-media-grant.service.js';
import {
  getPreparedTikTokDraft,
  revisePreparedTikTokDraftInTransaction,
} from '../src/modules/providers/tiktok-draft.service.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';

const connectionString = process.env.POSTGRES_CONSENT_TEST_URL;

describe.skipIf(!connectionString)('TikTok consent on PostgreSQL', () => {
  it('issues/verifies a tenant-scoped receipt and enforces RLS', async () => {
    const pool = new pg.Pool({ connectionString });
    const db = drizzle(pool);
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const userId = randomUUID();
    const postId = randomUUID();
    const revisionId = randomUUID();
    const mediaId = randomUUID();
    const accountId = randomUUID();
    const connectionId = randomUUID();
    const credentialId = randomUUID();
    const snapshotId = randomUUID();
    const options = {
      privacyLevel: 'SELF_ONLY' as const,
      allowComment: false,
      allowDuet: false,
      allowStitch: false,
      commercialContent: 'none' as const,
      aiGenerated: false,
    };
    try {
      await pool.query(
        `insert into workspaces (id, name, slug) values
        ($1, 'Consent Test', $3), ($2, 'Other Test', $4)`,
        [workspaceId, otherWorkspaceId, workspaceId, otherWorkspaceId],
      );
      await pool.query(
        `insert into users (id, email, display_name) values
        ($1, $2, 'Consent Tester')`,
        [userId, `${userId}@example.test`],
      );
      await pool.query(
        `insert into memberships (workspace_id, user_id, role)
        values ($1, $2, 'owner')`,
        [workspaceId, userId],
      );
      await pool.query(
        `insert into credentials (id, workspace_id, key_version, wrapped_key,
        wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
        values ($1, $2, 'fixture', '\\x01', '\\x01', '\\x01', '\\x01', '\\x01', '\\x01')`,
        [credentialId, workspaceId],
      );
      await pool.query(
        `insert into provider_connections (id, workspace_id, provider,
        external_subject_id, credential_id, scopes, refresh_expires_at)
        values ($1, $2, 'tiktok', 'subject-one', $3, '["video.publish"]', now() + interval '1 day')`,
        [connectionId, workspaceId, credentialId],
      );
      await pool.query(
        `insert into provider_accounts (id, workspace_id, connection_id,
        provider_account_id, destination_provider, remote_account_id, display_name)
        values ($1, $2, $3, 'subject-one', 'tiktok', 'subject-one', 'One')`,
        [accountId, workspaceId, connectionId],
      );
      await pool.query(
        `insert into media_objects (id, workspace_id, storage_key, sha256,
        mime_type, byte_size, duration_ms, width, height, video_codec, container, state)
        values ($1, $2, 'fixture.mp4', $3, 'video/mp4', 1024, 30000, 1080, 1920,
        'h264', 'mp4', 'ready')`,
        [mediaId, workspaceId, 'a'.repeat(64)],
      );
      await pool.query(
        `insert into posts (id, workspace_id, created_by_user_id)
        values ($1, $2, $3)`,
        [postId, workspaceId, userId],
      );
      await pool.query(
        `insert into post_revisions (id, workspace_id, post_id,
        revision_number, content) values ($1, $2, $3, 1, $4)`,
        [
          revisionId,
          workspaceId,
          postId,
          JSON.stringify({
            schemaVersion: 1,
            kind: 'video',
            caption: 'Exact caption',
            mediaId,
            options,
          }),
        ],
      );
      await pool.query(
        `insert into revision_media (workspace_id, revision_id, media_id,
        position) values ($1, $2, $3, 0)`,
        [workspaceId, revisionId, mediaId],
      );
      await pool.query(
        `insert into provider_capability_snapshots (id, workspace_id,
        account_id, connection_id, external_subject_id, credential_version, nickname,
        privacy_options, comment_disabled, duet_disabled, stitch_disabled,
        max_video_duration_seconds, fetched_at, expires_at)
        values ($1, $2, $3, $4, 'subject-one', 1, 'One', '["SELF_ONLY"]',
        false, true, true, 120, now() - interval '1 minute', now() + interval '14 minutes')`,
        [snapshotId, workspaceId, accountId, connectionId],
      );
      const receipt = await issueTikTokPublicationConsent(db, {
        workspaceId,
        userId,
        actor: { type: 'user', id: userId },
        postId,
        revisionId,
        accountId,
        capabilitySnapshotId: snapshotId,
        options,
        musicUsageConfirmed: true,
        brandedContentPolicyConfirmed: false,
      });
      const scope = {
        workspaceId,
        postId,
        revisionId,
        accountId,
        receiptId: receipt.id,
        actor: { type: 'user' as const, id: userId },
      };
      expect((await verifyTikTokPublicationConsent(db, scope)).mediaSha256).toBe('a'.repeat(64));
      expect(
        await getTikTokPublicationConsent(db, { workspaceId, userId, receiptId: receipt.id }),
      ).toMatchObject({ id: receipt.id, postId, revisionId, accountId });
      await expect(
        getTikTokPublicationConsent(db, {
          workspaceId: otherWorkspaceId,
          userId,
          receiptId: receipt.id,
        }),
      ).rejects.toThrow('not found');
      await expect(
        getTikTokPublicationConsent(db, {
          workspaceId,
          userId: randomUUID(),
          receiptId: receipt.id,
        }),
      ).rejects.toThrow('not found');
      expect(
        (
          await verifyTikTokPublicationConsent(db, {
            ...scope,
            actor: { type: 'api-key', id: randomUUID() },
          })
        ).mediaSha256,
      ).toBe('a'.repeat(64));
      await expect(
        verifyTikTokPublicationConsent(db, {
          ...scope,
          workspaceId: otherWorkspaceId,
        }),
      ).rejects.toThrow('invalid');
      const schedule = {
        workspaceId,
        userId,
        postId,
        revisionId,
        accountId,
        receiptId: receipt.id,
        scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
        requestId: 'postgres-schedule',
        idempotencyKey: 'postgres-schedule',
      };
      await expect(
        scheduleTikTokDraft(db, { ...schedule, workspaceId: otherWorkspaceId }),
      ).rejects.toThrow('invalid');
      const admitted = await scheduleTikTokDraft(db, schedule);
      expect(
        (await pool.query('select id from publication_jobs where id = $1', [admitted.jobId])).rows,
      ).toHaveLength(1);
      await expect(scheduleTikTokDraft(db, schedule)).rejects.toThrow('already scheduled');
      await pool.query('update media_objects set retained_at = now() where id = $1', [mediaId]);
      await pool.query(
        "update publication_jobs set scheduled_at = now() - interval '1 second' where id = $1",
        [admitted.jobId],
      );
      const now = new Date();
      const claimed = await claimExactDueJob(db, {
        workspaceId,
        jobId: admitted.jobId,
        workerId: 'postgres-fixture',
        now,
        leaseMs: 60_000,
      });
      expect(claimed?.id).toBe(admitted.jobId);
      const grant = await new TikTokMediaGrantService(db, Buffer.alloc(32, 7)).issue({
        workspaceId,
        accountId,
        mediaId,
        publicOrigin: 'https://media.example.test',
        now,
      });
      const attempt = await startDispatchAttempt(db, {
        workspaceId,
        jobId: admitted.jobId,
        workerId: 'postgres-fixture',
        fingerprint: 'exact-init-request',
        tiktokMediaGrantId: grant.id,
        now,
      });
      expect(attempt?.attemptId).toBeTruthy();
      const reserved = await pool.query<{
        tiktok_init_phase: string;
        tiktok_media_grant_id: string;
      }>(
        'select tiktok_init_phase, tiktok_media_grant_id from publication_attempts where job_id = $1',
        [admitted.jobId],
      );
      expect(reserved.rows[0]).toEqual({
        tiktok_init_phase: 'init_sending',
        tiktok_media_grant_id: grant.id,
      });
      expect(await recoverExpiredDispatches(db, new Date(Date.now() + 120_000))).toEqual([
        admitted.jobId,
      ]);
      expect(
        await claimExactDueJob(db, {
          workspaceId,
          jobId: admitted.jobId,
          workerId: 'postgres-fixture',
          now: new Date(Date.now() + 120_000),
          leaseMs: 60_000,
        }),
      ).toBeNull();
      await pool.query(
        `create role consent_reader_${receipt.id.replaceAll('-', '')} nologin nobypassrls`,
      );
      const role = `consent_reader_${receipt.id.replaceAll('-', '')}`;
      await pool.query(`grant select, insert on publication_consents to ${role}`);
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`set local role ${role}`);
        await client.query(`select set_config('app.workspace_id', $1, true)`, [otherWorkspaceId]);
        expect((await client.query('select id from publication_consents')).rows).toHaveLength(0);
        await client.query(`select set_config('app.workspace_id', $1, true)`, [workspaceId]);
        expect((await client.query('select id from publication_consents')).rows).toHaveLength(1);
        await client.query(`select set_config('app.workspace_id', $1, true)`, [otherWorkspaceId]);
        await expect(
          client.query(
            `insert into publication_consents (id, workspace_id, user_id,
          post_id, revision_id, account_id, media_id, media_sha256, capability_snapshot_id,
          credential_version, declaration_version, payload, payload_hash)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 1, '{}', $10)`,
            [
              randomUUID(),
              workspaceId,
              userId,
              postId,
              revisionId,
              accountId,
              mediaId,
              'a'.repeat(64),
              snapshotId,
              receipt.payloadHash,
            ],
          ),
        ).rejects.toThrow('row-level security');
      } finally {
        await client.query('rollback');
        client.release();
      }
      const preparedPostId = randomUUID();
      const preparedRevisionId = randomUUID();
      await pool.query(
        'insert into posts (id, workspace_id, created_by_user_id) values ($1, $2, $3)',
        [preparedPostId, workspaceId, userId],
      );
      const preparedContent = {
        schemaVersion: 1 as const,
        kind: 'video' as const,
        caption: 'Prepared',
        mediaId,
        options,
      };
      await pool.query(
        `insert into post_revisions (id, workspace_id, post_id, revision_number, content)
        values ($1, $2, $3, 1, $4)`,
        [preparedRevisionId, workspaceId, preparedPostId, JSON.stringify(preparedContent)],
      );
      await pool.query(
        `insert into revision_media (workspace_id, revision_id, media_id, position)
        values ($1, $2, $3, 0)`,
        [workspaceId, preparedRevisionId, mediaId],
      );
      const detail = await getPreparedTikTokDraft(db, {
        workspaceId,
        userId,
        postId: preparedPostId,
      });
      expect(detail.media.previewUrl).toBe(`/api/workflow/media/${mediaId}`);
      expect(JSON.stringify(detail)).not.toMatch(/storageKey|sha256|credential|fixture\.mp4/);
      expect(JSON.stringify(detail).length).toBeLessThan(6000);
      await expect(
        getPreparedTikTokDraft(db, { workspaceId, userId: randomUUID(), postId: preparedPostId }),
      ).rejects.toThrow();
      await expect(
        getPreparedTikTokDraft(db, {
          workspaceId: otherWorkspaceId,
          userId,
          postId: preparedPostId,
        }),
      ).rejects.toThrow();
      const revised = await withTenantTransaction(db, { workspaceId, userId }, (transaction) =>
        revisePreparedTikTokDraftInTransaction(transaction, {
          workspaceId,
          userId,
          postId: preparedPostId,
          content: { ...preparedContent, caption: 'Corrected' },
          requestId: 'postgres-corrected',
        }),
      );
      expect(revised.changed).toBe(true);
      const replay = await withTenantTransaction(db, { workspaceId, userId }, (transaction) =>
        revisePreparedTikTokDraftInTransaction(transaction, {
          workspaceId,
          userId,
          postId: preparedPostId,
          content: { ...preparedContent, caption: 'Corrected' },
          requestId: 'postgres-replay',
        }),
      );
      expect(replay).toEqual({ ...revised, changed: false });
      const concurrentContent = { ...preparedContent, caption: 'Concurrent correction' };
      const concurrent = await Promise.all(
        [1, 2].map((number) =>
          withTenantTransaction(db, { workspaceId, userId }, (transaction) =>
            revisePreparedTikTokDraftInTransaction(transaction, {
              workspaceId,
              userId,
              postId: preparedPostId,
              content: concurrentContent,
              requestId: `concurrent-${String(number)}`,
            }),
          ),
        ),
      );
      expect(concurrent[0]?.revisionId).toBe(concurrent[1]?.revisionId);
      expect(concurrent.map((result) => result.changed).sort()).toEqual([false, true]);
      expect(
        (
          await pool.query<{ count: number }>(
            'select count(*)::int as count from revision_media where media_id = $1',
            [mediaId],
          )
        ).rows[0]?.count,
      ).toBe(4);
      await pool.query(
        `insert into publication_jobs (workspace_id, post_id, revision_id,
        provider_account_id, effective_payload, scheduled_at)
        values ($1, $2, $3, $4, '{}', now() + interval '1 day')`,
        [workspaceId, preparedPostId, concurrent[0]?.revisionId, accountId],
      );
      await expect(
        withTenantTransaction(db, { workspaceId, userId }, (transaction) =>
          revisePreparedTikTokDraftInTransaction(transaction, {
            workspaceId,
            userId,
            postId: preparedPostId,
            content: preparedContent,
            requestId: 'job-guard',
          }),
        ),
      ).rejects.toThrow('already scheduled');
      await pool.query(`grant usage on schema public to ${role}`);
      await pool.query(`grant select on posts, post_revisions, revision_media, media_objects,
        publication_jobs, memberships, provider_accounts, provider_connections to ${role}`);
      const rlsClient = await pool.connect();
      try {
        await rlsClient.query('begin');
        await rlsClient.query(`set local role ${role}`);
        await rlsClient.query(`select set_config('app.workspace_id', $1, true)`, [
          otherWorkspaceId,
        ]);
        expect(
          (await rlsClient.query('select id from posts where id = $1', [preparedPostId])).rows,
        ).toHaveLength(0);
        await rlsClient.query(`select set_config('app.workspace_id', $1, true)`, [workspaceId]);
        expect(
          (await rlsClient.query('select id from posts where id = $1', [preparedPostId])).rows,
        ).toHaveLength(1);
      } finally {
        await rlsClient.query('rollback');
        rlsClient.release();
      }
      const rolePostId = randomUUID();
      const roleRevisionId = randomUUID();
      await pool.query(
        'insert into posts (id, workspace_id, created_by_user_id) values ($1, $2, $3)',
        [rolePostId, workspaceId, userId],
      );
      await pool.query(
        `insert into post_revisions (id, workspace_id, post_id, revision_number, content)
        values ($1, $2, $3, 1, $4)`,
        [roleRevisionId, workspaceId, rolePostId, JSON.stringify(preparedContent)],
      );
      await pool.query(
        `insert into revision_media (workspace_id, revision_id, media_id, position)
        values ($1, $2, $3, 0)`,
        [workspaceId, roleRevisionId, mediaId],
      );
      await pool.query(`grant insert on post_revisions, revision_media to ${role}`);
      await pool.query(`grant update on posts, media_objects to ${role}`);
      const actorClient = await pool.connect();
      try {
        await actorClient.query(`set role ${role}`);
        const actorDb = drizzle(actorClient);
        const roleDetail = await getPreparedTikTokDraft(actorDb, {
          workspaceId,
          userId,
          postId: rolePostId,
        });
        expect(roleDetail.revisionId).toBe(roleRevisionId);
        const roleRevision = await withTenantTransaction(
          actorDb,
          { workspaceId, userId },
          (transaction) =>
            revisePreparedTikTokDraftInTransaction(transaction, {
              workspaceId,
              userId,
              postId: rolePostId,
              content: { ...preparedContent, caption: 'Role correction' },
              requestId: 'forced-rls-role',
            }),
        );
        expect(roleRevision.changed).toBe(true);
        await expect(
          getPreparedTikTokDraft(actorDb, {
            workspaceId: otherWorkspaceId,
            userId,
            postId: rolePostId,
          }),
        ).rejects.toThrow();
      } finally {
        await actorClient.query('reset role');
        actorClient.release();
      }
    } finally {
      await pool.end();
    }
  });
});
