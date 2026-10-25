import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { getActiveCredential } from '../src/modules/credentials/credential.repository.js';
import { decryptCredential } from '../src/modules/credentials/envelope.js';
import {
  activateFanvuePaymentSubscription,
  disableFanvuePaymentSubscription,
  getFanvuePaymentSubscriptionForAccount,
  markFanvueSubscriptionCreationUnknown,
  reserveFanvuePaymentSubscription,
} from '../src/modules/providers/fanvue-payment-subscription.repository.js';

const connectionString = process.env.POSTGRES_FANVUE_TEST_URL;
const keys = { currentVersion: () => 'v1', getKey: () => Promise.resolve(Buffer.alloc(32, 9)) };

describe.skipIf(!connectionString)('Fanvue payment subscription on PostgreSQL', () => {
  it('binds one opaque callback and encrypted returned secret to the exact creator account', async () => {
    const pool = new pg.Pool({ connectionString });
    const database = drizzle(pool);
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const accountId = randomUUID();
    const creatorUuid = randomUUID();
    const connectionId = randomUUID();
    const credentialId = randomUUID();
    try {
      for (const id of [workspaceId, otherWorkspaceId])
        await pool.query('INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)', [
          id,
          'Fanvue subscription fixture',
          id,
        ]);
      await pool.query(
        `INSERT INTO credentials
         (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
         VALUES ($1, $2, 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06')`,
        [credentialId, workspaceId],
      );
      await pool.query(
        `INSERT INTO provider_connections
         (id, workspace_id, provider, credential_id, external_subject_id, scopes)
         VALUES ($1, $2, 'fanvue', $3, $4, '["read:self","read:creator"]'::jsonb)`,
        [connectionId, workspaceId, credentialId, creatorUuid],
      );
      await pool.query(
        `INSERT INTO provider_accounts
         (id, workspace_id, connection_id, provider_account_id, display_name, destination_provider, remote_account_id)
         VALUES ($1, $2, $3, $4, 'Creator', 'fanvue', $4)`,
        [accountId, workspaceId, connectionId, creatorUuid],
      );
      const selected = { workspaceId, accountId, creatorUuid };
      await expect(
        reserveFanvuePaymentSubscription(database, { ...selected, workspaceId: otherWorkspaceId }),
      ).rejects.toThrow('unavailable');
      await expect(
        reserveFanvuePaymentSubscription(database, { ...selected, creatorUuid: randomUUID() }),
      ).rejects.toThrow('unavailable');
      await pool.query(
        'UPDATE provider_connections SET scopes=\'["read:self"]\'::jsonb WHERE id=$1',
        [connectionId],
      );
      await expect(reserveFanvuePaymentSubscription(database, selected)).rejects.toThrow(
        'unavailable',
      );
      await pool.query(
        'UPDATE provider_connections SET scopes=\'["read:self","read:creator"]\'::jsonb WHERE id=$1',
        [connectionId],
      );
      const reserved = await reserveFanvuePaymentSubscription(database, selected);
      expect(reserved.callbackHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await getFanvuePaymentSubscriptionForAccount(database, selected)).toMatchObject({
        id: reserved.id,
        creatorUuid,
        state: 'probe_pending',
      });
      await expect(reserveFanvuePaymentSubscription(database, selected)).rejects.toThrow();
      const stored = await pool.query<{ callback_handle_hash: string }>(
        'SELECT callback_handle_hash FROM fanvue_payment_subscriptions WHERE id=$1',
        [reserved.id],
      );
      expect(stored.rows[0]?.callback_handle_hash).not.toContain(reserved.callbackHandle);
      await pool.query(
        'UPDATE provider_connections SET scopes=\'["read:self"]\'::jsonb WHERE id=$1',
        [connectionId],
      );
      await expect(
        markFanvueSubscriptionCreationUnknown(database, { workspaceId, id: reserved.id }),
      ).rejects.toThrow('unavailable');
      await pool.query(
        'UPDATE provider_connections SET scopes=\'["read:self","read:creator"]\'::jsonb WHERE id=$1',
        [connectionId],
      );
      await markFanvueSubscriptionCreationUnknown(database, { workspaceId, id: reserved.id });
      await expect(
        markFanvueSubscriptionCreationUnknown(database, { workspaceId, id: reserved.id }),
      ).rejects.toThrow('not ready');
      const signingSecret = 'returned-once-fixture-secret';
      await activateFanvuePaymentSubscription(database, keys, {
        workspaceId,
        id: reserved.id,
        providerSubscriptionId: 'fanvue-subscription-1',
        signingSecret,
      });
      const active = await getFanvuePaymentSubscriptionForAccount(database, selected);
      expect(active).toMatchObject({
        id: reserved.id,
        state: 'active',
        providerSubscriptionId: 'fanvue-subscription-1',
      });
      expect(
        await getFanvuePaymentSubscriptionForAccount(database, {
          workspaceId: otherWorkspaceId,
          accountId,
        }),
      ).toBeNull();
      const secretId = await pool.query<{ signing_credential_id: string }>(
        'SELECT signing_credential_id FROM fanvue_payment_subscriptions WHERE id=$1',
        [reserved.id],
      );
      const encrypted = await getActiveCredential(
        database,
        workspaceId,
        secretId.rows[0]?.signing_credential_id ?? '',
      );
      if (!encrypted) throw new Error('Signing credential was not stored');
      const decrypted = await decryptCredential(encrypted, keys);
      expect(decrypted.toString('utf8')).toBe(signingSecret);
      decrypted.fill(0);
      await expect(
        activateFanvuePaymentSubscription(database, keys, {
          workspaceId,
          id: reserved.id,
          providerSubscriptionId: 'another',
          signingSecret: 'another',
        }),
      ).rejects.toThrow('reconciliation');
      await expect(
        disableFanvuePaymentSubscription(database, {
          workspaceId,
          id: reserved.id,
          providerSubscriptionId: 'wrong-provider-id',
        }),
      ).rejects.toThrow('reconciliation');
      await disableFanvuePaymentSubscription(database, {
        workspaceId,
        id: reserved.id,
        providerSubscriptionId: 'fanvue-subscription-1',
      });
      expect(await getActiveCredential(database, workspaceId, encrypted.id)).toBeNull();
      expect(await getFanvuePaymentSubscriptionForAccount(database, selected)).toBeNull();
      expect((await reserveFanvuePaymentSubscription(database, selected)).id).not.toBe(reserved.id);
    } finally {
      await pool.query('DELETE FROM fanvue_payment_subscriptions WHERE workspace_id=$1', [
        workspaceId,
      ]);
      await pool.query('DELETE FROM provider_account_exposures WHERE workspace_id=$1', [
        workspaceId,
      ]);
      await pool.query('DELETE FROM provider_accounts WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM provider_connections WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM credentials WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM workspaces WHERE id IN ($1, $2)', [
        workspaceId,
        otherWorkspaceId,
      ]);
      await pool.end();
    }
  });
});
