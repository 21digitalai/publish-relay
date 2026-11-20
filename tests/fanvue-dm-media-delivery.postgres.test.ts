import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import {
  cancelReservedFanvueDmMedia,
  FanvueDmMediaAlreadyUsedError,
  listFanvueDmMediaDeliveryStates,
  recordFanvueDmHistoryMedia,
  reserveFanvueDmMedia,
  settleFanvueDmMedia,
} from '../src/modules/providers/fanvue-dm-media-delivery.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000002';
const accountId = '00000000-0000-4000-8000-000000000003';
const fanUuid = '00000000-0000-4000-8000-000000000004';
const mediaUuid = '00000000-0000-4000-8000-000000000005';
const messageUuid = '00000000-0000-4000-8000-000000000006';

async function setup() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL,
      destination_provider text NOT NULL, PRIMARY KEY (workspace_id,id));
    INSERT INTO provider_accounts VALUES ('${accountId}','${workspaceId}','fanvue'),
      ('${accountId}','${otherWorkspaceId}','fanvue');
  `);
  await pg.exec(
    await readFile(
      new URL('../migrations/0127_fanvue_dm_conversation_facts.sql', import.meta.url),
      'utf8',
    ),
  );
  return { pg, database: drizzle(pg) as unknown as NodePgDatabase };
}

function command(clientActionId: string) {
  return {
    workspaceId,
    accountId,
    fanUuid,
    clientActionId,
    providerMediaUuids: [mediaUuid],
  };
}

describe('Fanvue per-fan media delivery fence', () => {
  it('permits exactly one reservation across different action IDs', async () => {
    const { pg, database } = await setup();
    try {
      const first = command('00000000-0000-4000-8000-000000000007');
      const second = command('00000000-0000-4000-8000-000000000008');
      const results = await Promise.allSettled([
        reserveFanvueDmMedia(database, first),
        reserveFanvueDmMedia(database, second),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejection = results.find((result) => result.status === 'rejected');
      expect(rejection?.status).toBe('rejected');
      if (rejection?.status === 'rejected') {
        const reason: unknown = rejection.reason;
        expect(reason).toBeInstanceOf(FanvueDmMediaAlreadyUsedError);
      }
    } finally {
      await pg.close();
    }
  });

  it('keeps unknown blocked, releases only reserved cancellation, and imports manual history', async () => {
    const { pg, database } = await setup();
    try {
      const action = command('00000000-0000-4000-8000-000000000007');
      await reserveFanvueDmMedia(database, action);
      const actionIdentity = {
        workspaceId,
        accountId,
        fanUuid,
        clientActionId: action.clientActionId,
      };
      await settleFanvueDmMedia(database, { ...actionIdentity, state: 'unknown' });
      expect(await cancelReservedFanvueDmMedia(database, actionIdentity)).toEqual([]);
      await expect(
        reserveFanvueDmMedia(database, command('00000000-0000-4000-8000-000000000008')),
      ).rejects.toBeInstanceOf(FanvueDmMediaAlreadyUsedError);
      expect(
        await listFanvueDmMediaDeliveryStates(database, {
          workspaceId,
          accountId,
          fanUuid,
          providerMediaUuids: [mediaUuid],
        }),
      ).toMatchObject([{ providerMediaUuid: mediaUuid, state: 'unknown' }]);

      const otherMediaUuid = '00000000-0000-4000-8000-000000000009';
      expect(
        await recordFanvueDmHistoryMedia(database, {
          workspaceId,
          accountId,
          fanUuid,
          providerMediaUuid: otherMediaUuid,
          providerMessageUuid: messageUuid,
        }),
      ).toEqual(expect.any(String));
      expect(
        await recordFanvueDmHistoryMedia(database, {
          workspaceId,
          accountId,
          fanUuid,
          providerMediaUuid: otherMediaUuid,
          providerMessageUuid: messageUuid,
        }),
      ).toBeNull();
    } finally {
      await pg.close();
    }
  });

  it('isolates workspace state and allows cancelled media to be reserved again', async () => {
    const { pg, database } = await setup();
    try {
      const first = command('00000000-0000-4000-8000-000000000007');
      const reservationIds = await reserveFanvueDmMedia(database, first);
      expect(await reserveFanvueDmMedia(database, first)).toEqual(reservationIds);
      expect(
        await cancelReservedFanvueDmMedia(database, {
          workspaceId,
          accountId,
          fanUuid,
          clientActionId: first.clientActionId,
        }),
      ).toHaveLength(1);
      await expect(
        reserveFanvueDmMedia(database, command('00000000-0000-4000-8000-000000000008')),
      ).resolves.toHaveLength(1);
      expect(
        await listFanvueDmMediaDeliveryStates(database, {
          workspaceId: otherWorkspaceId,
          accountId,
          fanUuid,
          providerMediaUuids: [mediaUuid],
        }),
      ).toEqual([]);
    } finally {
      await pg.close();
    }
  });
});
