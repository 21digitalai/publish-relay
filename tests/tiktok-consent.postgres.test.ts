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
    } finally {
      await pool.end();
    }
  });
});
