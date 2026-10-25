import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  cleanupRetainedMedia,
  createFixedMediaRetentionPolicy,
  deleteUnattachedMedia,
  evaluateMediaRetention,
} from '../src/modules/content/media-retention.service.js';
import type { MediaStorage } from '../src/modules/content/media-storage.js';
import { getActiveCredential } from '../src/modules/credentials/credential.repository.js';
import { decryptCredential } from '../src/modules/credentials/envelope.js';
import {
  bindFanvueDmAttachment,
  releaseUnstartedFanvueDmAttachment,
} from '../src/modules/providers/fanvue-dm-attachment.repository.js';
import { initializeFanvueDmUpload } from '../src/modules/providers/fanvue-dm-upload-init.service.js';
import type { FanvueMediaUploadClient } from '../src/modules/providers/fanvue-media-upload-client.js';

const connectionString = process.env.POSTGRES_FANVUE_TEST_URL;

describe.skipIf(!connectionString)('Fanvue DM local media ownership on PostgreSQL', () => {
  it('binds ready account media before upload and blocks all three deletion gates', async () => {
    const pool = new pg.Pool({ connectionString, max: 4 });
    const db = drizzle(pool);
    const workspaceId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const accountId = randomUUID();
    const connectionId = randomUUID();
    const credentialId = randomUUID();
    const mediaId = randomUUID();
    const actionId = randomUUID();
    const deleted: string[] = [];
    const storage = {
      delete: (key: string) => {
        deleted.push(key);
        return Promise.resolve();
      },
    } as MediaStorage;
    const key = { workspaceId, accountId, clientActionId: actionId, mediaId };
    try {
      for (const id of [workspaceId, foreignWorkspaceId])
        await pool.query('INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)', [
          id,
          'DM test',
          id,
        ]);
      await pool.query(
        `INSERT INTO credentials
        (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
        VALUES ($1, $2, 'v1', '\x01', '\x02', '\x03', '\x04', '\x05', '\x06')`,
        [credentialId, workspaceId],
      );
      await pool.query(
        `INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
        VALUES ($1, $2, 'fanvue', $3)`,
        [connectionId, workspaceId, credentialId],
      );
      await pool.query(
        `INSERT INTO provider_accounts
        (id, workspace_id, connection_id, provider_account_id, display_name, destination_provider, remote_account_id)
        VALUES ($1, $2, $3, 'creator', 'Creator', 'fanvue', 'creator')`,
        [accountId, workspaceId, connectionId],
      );
      await pool.query(
        `INSERT INTO media_objects
        (id, workspace_id, storage_key, sha256, mime_type, byte_size, state, retained_at)
        VALUES ($1, $2, 'dm-object', 'dm-hash', 'image/png', 12, 'ready', '2026-08-01')`,
        [mediaId, workspaceId],
      );
      await expect(
        bindFanvueDmAttachment(db, { ...key, workspaceId: foreignWorkspaceId }),
      ).resolves.toBe(false);
      await expect(bindFanvueDmAttachment(db, key)).resolves.toBe(true);
      await expect(bindFanvueDmAttachment(db, key)).resolves.toBe(true);
      const count = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM fanvue_dm_attachments WHERE media_id=$1',
        [mediaId],
      );
      expect(count.rows[0]?.count).toBe(1);
      const now = new Date('2026-09-02');
      await expect(deleteUnattachedMedia(db, storage, { workspaceId, mediaId, now })).resolves.toBe(
        false,
      );
      await expect(
        evaluateMediaRetention(db, {
          workspaceId,
          now,
          policy: createFixedMediaRetentionPolicy(0),
        }),
      ).resolves.toBe(0);
      await pool.query(
        `UPDATE media_objects SET state='cleanup_eligible',
        cleanup_eligible_at='2026-09-01' WHERE id=$1`,
        [mediaId],
      );
      await expect(
        cleanupRetainedMedia(db, storage, {
          workspaceId,
          now,
          retryDelayMs: 1000,
          staleClaimBefore: new Date('2026-09-01'),
        }),
      ).resolves.toEqual({ deleted: 0, failed: 0 });
      expect(deleted).toEqual([]);
      await expect(releaseUnstartedFanvueDmAttachment(db, key)).resolves.toBe(true);
      await expect(bindFanvueDmAttachment(db, key)).resolves.toBe(false);
      await expect(
        cleanupRetainedMedia(db, storage, {
          workspaceId,
          now,
          retryDelayMs: 1000,
          staleClaimBefore: new Date('2026-09-01'),
        }),
      ).resolves.toEqual({ deleted: 1, failed: 0 });
      expect(deleted).toEqual(['dm-object']);

      const uploadMediaId = randomUUID();
      const providerMediaUuid = randomUUID();
      await pool.query(
        `INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
         VALUES ($1, $2, 'dm-upload', 'dm-upload-hash', 'image/png', 12, 'ready')`,
        [uploadMediaId, workspaceId],
      );
      const uploadKey = { ...key, mediaId: uploadMediaId };
      expect(await bindFanvueDmAttachment(db, uploadKey)).toBe(true);
      const createSession = vi.fn().mockResolvedValue({
        mediaUuid: providerMediaUuid,
        uploadId: 'upload-one',
        partSize: 12,
        maxParts: 256,
        totalParts: 1,
      });
      const client = { createSession } as unknown as FanvueMediaUploadClient;
      const keys = {
        currentVersion: () => 'v1',
        getKey: () => Promise.resolve(Buffer.alloc(32, 7)),
      };
      await expect(
        initializeFanvueDmUpload(db, client, keys, {
          ...uploadKey,
          accessToken: 'fixture-token',
        }),
      ).resolves.toEqual({ state: 'uploading', mediaUuid: providerMediaUuid });
      await expect(
        initializeFanvueDmUpload(db, client, keys, {
          ...uploadKey,
          accessToken: 'fixture-token',
        }),
      ).rejects.toThrow('not ready');
      expect(createSession).toHaveBeenCalledTimes(1);
      const upload = await pool.query<{ state: string; upload_credential_id: string }>(
        'SELECT state, upload_credential_id FROM fanvue_dm_attachments WHERE media_id=$1',
        [uploadMediaId],
      );
      expect(upload.rows[0]?.state).toBe('uploading');
      if (!upload.rows[0]?.upload_credential_id) throw new Error('Upload credential is missing');
      const credential = await getActiveCredential(
        db,
        workspaceId,
        upload.rows[0].upload_credential_id,
      );
      expect(credential).not.toBeNull();
      if (!credential) throw new Error('Encrypted upload session is missing');
      const plaintext = await decryptCredential(credential, keys);
      expect(JSON.parse(plaintext.toString('utf8'))).toMatchObject({
        mediaUuid: providerMediaUuid,
      });
      plaintext.fill(0);

      const unknownMediaId = randomUUID();
      await pool.query(
        `INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
         VALUES ($1, $2, 'dm-unknown', 'dm-unknown-hash', 'image/png', 12, 'ready')`,
        [unknownMediaId, workspaceId],
      );
      const unknownKey = { ...key, mediaId: unknownMediaId };
      expect(await bindFanvueDmAttachment(db, unknownKey)).toBe(true);
      createSession.mockRejectedValueOnce(new Error('response lost'));
      await expect(
        initializeFanvueDmUpload(db, client, keys, {
          ...unknownKey,
          accessToken: 'fixture-token',
        }),
      ).rejects.toThrow('response lost');
      await expect(
        initializeFanvueDmUpload(db, client, keys, {
          ...unknownKey,
          accessToken: 'fixture-token',
        }),
      ).rejects.toThrow('not ready');
      expect(createSession).toHaveBeenCalledTimes(2);
      const unknown = await pool.query<{ state: string }>(
        'SELECT state FROM fanvue_dm_attachments WHERE media_id=$1',
        [unknownMediaId],
      );
      expect(unknown.rows[0]?.state).toBe('unknown');
      await expect(deleteUnattachedMedia(db, storage, {
        workspaceId, mediaId: unknownMediaId,
      })).resolves.toBe(false);

      const racingMediaId = randomUUID();
      await pool.query(
        `INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
         VALUES ($1, $2, 'dm-race', 'dm-race-hash', 'image/png', 12, 'ready')`,
        [racingMediaId, workspaceId],
      );
      const [bound, removed] = await Promise.all([
        bindFanvueDmAttachment(db, { ...key, mediaId: racingMediaId }),
        deleteUnattachedMedia(db, storage, { workspaceId, mediaId: racingMediaId }),
      ]);
      expect(bound && removed).toBe(false);
      const race = await pool.query<{ state: string; active: number }>(
        `SELECT media.state,
          (SELECT count(*)::int FROM fanvue_dm_attachments dm
           WHERE dm.media_id=media.id AND dm.state<>'released') AS active
         FROM media_objects media WHERE media.id=$1`,
        [racingMediaId],
      );
      expect(race.rows[0]?.state === 'deleted' && race.rows[0].active > 0).toBe(false);
    } finally {
      await pool.query('DELETE FROM fanvue_dm_attachments WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM media_objects WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM provider_account_exposures WHERE workspace_id=$1', [
        workspaceId,
      ]);
      await pool.query('DELETE FROM provider_accounts WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM provider_connections WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM credentials WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM workspaces WHERE id IN ($1, $2)', [
        workspaceId,
        foreignWorkspaceId,
      ]);
      await pool.end();
    }
  });
});
