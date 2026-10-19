import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
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

const connectionString = process.env.POSTGRES_SNAPCHAT_STORY_TEST_URL;

describe.skipIf(!connectionString)('Snapchat Story authority on real PostgreSQL', () => {
  it('reads only a tenant-owned, current owner-profile media job under forced RLS', async () => {
    const pool = new pg.Pool({ connectionString });
    const client = await pool.connect();
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const userId = randomUUID();
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
        'insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)',
        [workspaceId, userId, 'owner'],
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
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  });
});
