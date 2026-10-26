import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  findFanvueAction,
  reserveFanvueAction,
  settleFanvueAction,
} from '../src/modules/providers/fanvue-action-intent.repository.js';

const connectionString = process.env.POSTGRES_FANVUE_TEST_URL;

describe.skipIf(!connectionString)('Fanvue durable action intent on PostgreSQL', () => {
  it('reserves before sending, rejects changed replays, and preserves unknown outcomes', async () => {
    const pool = new pg.Pool({ connectionString, max: 4 });
    const database = drizzle(pool);
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const accountId = randomUUID();
    const credentialId = randomUUID();
    const connectionId = randomUUID();
    const input = {
      workspaceId,
      accountId,
      clientActionId: randomUUID(),
      actionKind: 'message' as const,
      targetUuid: randomUUID(),
      requestFingerprint: 'a'.repeat(64),
    };
    try {
      await pool.query('INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)', [
        workspaceId,
        'Fanvue intent',
        workspaceId,
      ]);
      await pool.query(
        `INSERT INTO credentials
        (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
        VALUES ($1, $2, 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06')`,
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
      const reserved = await reserveFanvueAction(database, input);
      expect(reserved.kind).toBe('new');
      expect(await findFanvueAction(database, input)).toMatchObject({
        kind: 'existing',
        state: 'reserved',
      });
      if (reserved.kind !== 'new') throw new Error('First reservation was not new');
      const replays = await Promise.all([
        reserveFanvueAction(database, input),
        reserveFanvueAction(database, input),
      ]);
      for (const replay of replays) {
        expect(replay).toMatchObject({ kind: 'existing', state: 'reserved' });
        expect(replay).not.toHaveProperty('id');
      }
      await expect(
        settleFanvueAction(database, {
          workspaceId,
          accountId,
          clientActionId: input.clientActionId,
          reservationId: randomUUID(),
          result: { state: 'confirmed', providerObjectUuid: randomUUID() },
        }),
      ).rejects.toThrow('not reserved');
      expect(await reserveFanvueAction(database, input)).toMatchObject({
        kind: 'existing',
        state: 'reserved',
      });
      expect(
        await reserveFanvueAction(database, { ...input, requestFingerprint: 'b'.repeat(64) }),
      ).toEqual({ kind: 'conflict' });
      expect(
        await findFanvueAction(database, { ...input, requestFingerprint: 'b'.repeat(64) }),
      ).toEqual({ kind: 'conflict' });
      await settleFanvueAction(database, {
        workspaceId,
        accountId,
        clientActionId: input.clientActionId,
        reservationId: reserved.id,
        result: { state: 'unknown' },
      });
      expect(await reserveFanvueAction(database, input)).toMatchObject({
        kind: 'existing',
        state: 'unknown',
        providerObjectUuid: null,
      });
      expect(await findFanvueAction(database, input)).toMatchObject({
        kind: 'existing',
        state: 'unknown',
      });
      expect(
        await findFanvueAction(database, { ...input, clientActionId: randomUUID() }),
      ).toBeNull();
      await expect(
        settleFanvueAction(database, {
          workspaceId,
          accountId,
          clientActionId: input.clientActionId,
          reservationId: reserved.id,
          result: { state: 'confirmed', providerObjectUuid: randomUUID() },
        }),
      ).rejects.toThrow('not reserved');
      const confirmedAction = { ...input, clientActionId: randomUUID() };
      const providerObjectUuid = randomUUID();
      const confirmedReservation = await reserveFanvueAction(database, confirmedAction);
      if (confirmedReservation.kind !== 'new')
        throw new Error('Confirmation reservation was not new');
      await settleFanvueAction(database, {
        workspaceId,
        accountId,
        clientActionId: confirmedAction.clientActionId,
        reservationId: confirmedReservation.id,
        result: { state: 'confirmed', providerObjectUuid },
      });
      expect(await reserveFanvueAction(database, confirmedAction)).toMatchObject({
        kind: 'existing',
        state: 'confirmed',
        providerObjectUuid,
      });
      expect(await findFanvueAction(database, confirmedAction)).toMatchObject({
        kind: 'existing',
        state: 'confirmed',
        providerObjectUuid,
      });
      expect(
        await findFanvueAction(database, { ...confirmedAction, workspaceId: otherWorkspaceId }),
      ).toBeNull();
      const chatCreate = {
        ...input,
        clientActionId: randomUUID(),
        actionKind: 'chat_create' as const,
      };
      const chatReservation = await reserveFanvueAction(database, chatCreate);
      expect(chatReservation.kind).toBe('new');
      if (chatReservation.kind !== 'new') throw new Error('Chat creation was not reserved');
      expect(await reserveFanvueAction(database, chatCreate)).toMatchObject({
        kind: 'existing',
        state: 'reserved',
      });
      expect(await reserveFanvueAction(database, { ...chatCreate, actionKind: 'message' })).toEqual(
        { kind: 'conflict' },
      );
      await settleFanvueAction(database, {
        workspaceId,
        accountId,
        clientActionId: chatCreate.clientActionId,
        reservationId: chatReservation.id,
        result: { state: 'confirmed', providerObjectUuid: chatCreate.targetUuid },
      });
      expect(await reserveFanvueAction(database, chatCreate)).toMatchObject({
        kind: 'existing',
        state: 'confirmed',
        providerObjectUuid: chatCreate.targetUuid,
      });
      const deniedAction = { ...input, clientActionId: randomUUID() };
      const deniedReservation = await reserveFanvueAction(database, deniedAction);
      if (deniedReservation.kind !== 'new') throw new Error('Denial reservation was not new');
      await settleFanvueAction(database, {
        workspaceId,
        accountId,
        clientActionId: deniedAction.clientActionId,
        reservationId: deniedReservation.id,
        result: { state: 'failed', failureStatus: 403 },
      });
      expect(await reserveFanvueAction(database, deniedAction)).toMatchObject({
        kind: 'existing',
        state: 'failed',
        failureStatus: 403,
      });
      await expect(
        reserveFanvueAction(database, { ...input, workspaceId: otherWorkspaceId }),
      ).rejects.toThrow();
    } finally {
      await pool.query('DELETE FROM fanvue_action_intents WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM provider_account_exposures WHERE workspace_id=$1', [
        workspaceId,
      ]);
      await pool.query('DELETE FROM provider_accounts WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM provider_connections WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM credentials WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
      await pool.end();
    }
  });
});
