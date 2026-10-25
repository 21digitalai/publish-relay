import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  cleanupRetainedMedia,
  createFixedMediaRetentionPolicy,
  deleteUnattachedMedia,
  evaluateMediaRetention,
} from '../src/modules/content/media-retention.service.js';
import type { MediaStorage } from '../src/modules/content/media-storage.js';
import {
  bindFanvueDmAttachment,
  releaseUnstartedFanvueDmAttachment,
} from '../src/modules/providers/fanvue-dm-attachment.repository.js';

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
