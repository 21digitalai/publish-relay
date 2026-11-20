import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import {
  FanvueDmCheckpointConflictError,
  listFanvueDmCheckpoints,
  reserveFanvueDmCheckpoint,
  settleFanvueDmCheckpoint,
} from '../src/modules/providers/fanvue-dm-checkpoint.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const fanUuid = '00000000-0000-4000-8000-000000000003';
const clientActionId = '00000000-0000-4000-8000-000000000004';
const providerMessageUuid = '00000000-0000-4000-8000-000000000005';
const groupId = '00000000-0000-4000-8000-000000000006';
const providerMediaUuid = '00000000-0000-4000-8000-000000000007';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000008';

async function setup() {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL,
    destination_provider text NOT NULL, PRIMARY KEY (workspace_id,id));
    INSERT INTO provider_accounts VALUES ('${accountId}','${workspaceId}','fanvue');`);
  await pg.exec(
    await readFile(
      new URL('../migrations/0127_fanvue_dm_conversation_facts.sql', import.meta.url),
      'utf8',
    ),
  );
  return { pg, database: drizzle(pg) as unknown as NodePgDatabase };
}

describe('Fanvue conversation checkpoints', () => {
  it('reserves idempotently, keeps action/group/media ownership immutable and settles once', async () => {
    const { pg, database } = await setup();
    const input = {
      workspaceId,
      accountId,
      fanUuid,
      kind: 'welcome' as const,
      ordinal: 1,
      clientActionId,
      groupId,
      providerMediaUuid,
    };
    const settlementInput = {
      workspaceId,
      accountId,
      fanUuid,
      kind: input.kind,
      ordinal: input.ordinal,
      clientActionId,
    };
    try {
      const first = await reserveFanvueDmCheckpoint(database, input);
      expect(await reserveFanvueDmCheckpoint(database, input)).toMatchObject({ id: first.id });
      await expect(
        reserveFanvueDmCheckpoint(database, {
          ...input,
          clientActionId: providerMessageUuid,
        }),
      ).rejects.toBeInstanceOf(FanvueDmCheckpointConflictError);
      await expect(
        reserveFanvueDmCheckpoint(database, { ...input, groupId: providerMessageUuid }),
      ).rejects.toBeInstanceOf(FanvueDmCheckpointConflictError);
      await expect(
        reserveFanvueDmCheckpoint(database, { ...input, providerMediaUuid: providerMessageUuid }),
      ).rejects.toBeInstanceOf(FanvueDmCheckpointConflictError);
      await expect(
        settleFanvueDmCheckpoint(database, {
          ...settlementInput,
          state: 'confirmed',
          providerMessageUuid,
        }),
      ).resolves.toMatchObject({ state: 'confirmed', providerMessageUuid });
      await expect(
        settleFanvueDmCheckpoint(database, { ...settlementInput, state: 'unknown' }),
      ).rejects.toBeInstanceOf(FanvueDmCheckpointConflictError);
      expect(await listFanvueDmCheckpoints(database, { workspaceId, accountId, fanUuid })).toEqual([
        expect.objectContaining({ kind: 'welcome', ordinal: 1, state: 'confirmed' }),
      ]);
    } finally {
      await pg.close();
    }
  });

  it('stores unknown without a provider receipt and does not reopen the checkpoint', async () => {
    const { pg, database } = await setup();
    const input = {
      workspaceId,
      accountId,
      fanUuid,
      kind: 'paid_offer' as const,
      ordinal: 1,
      clientActionId,
    };
    try {
      await reserveFanvueDmCheckpoint(database, input);
      await expect(
        settleFanvueDmCheckpoint(database, { ...input, state: 'unknown' }),
      ).resolves.toMatchObject({ state: 'unknown', providerMessageUuid: null });
      await expect(
        settleFanvueDmCheckpoint(database, {
          ...input,
          state: 'unknown',
          // @ts-expect-error unknown settlements must not carry provider receipt identity
          providerMessageUuid,
        }),
      ).rejects.toThrow();
      await expect(reserveFanvueDmCheckpoint(database, input)).resolves.toMatchObject({
        state: 'unknown',
      });
    } finally {
      await pg.close();
    }
  });

  it('cancels only the pending checkpoint and rejects later reuse', async () => {
    const { pg, database } = await setup();
    const input = {
      workspaceId,
      accountId,
      fanUuid,
      kind: 'silent_followup' as const,
      ordinal: 1,
      clientActionId,
    };
    try {
      await reserveFanvueDmCheckpoint(database, input);
      await expect(
        settleFanvueDmCheckpoint(database, { ...input, state: 'cancelled' }),
      ).resolves.toMatchObject({ state: 'cancelled', providerMessageUuid: null });
      await expect(reserveFanvueDmCheckpoint(database, input)).rejects.toBeInstanceOf(
        FanvueDmCheckpointConflictError,
      );
    } finally {
      await pg.close();
    }
  });

  it('denies an account identity from another workspace', async () => {
    const { pg, database } = await setup();
    try {
      await expect(
        reserveFanvueDmCheckpoint(database, {
          workspaceId: otherWorkspaceId,
          accountId,
          fanUuid,
          kind: 'free_gift',
          ordinal: 1,
          clientActionId,
        }),
      ).rejects.toBeInstanceOf(FanvueDmCheckpointConflictError);
    } finally {
      await pg.close();
    }
  });

  it('returns a deterministic hard maximum of 100 allowlisted checkpoints', async () => {
    const { pg, database } = await setup();
    try {
      await pg.exec(`INSERT INTO fanvue_dm_conversation_checkpoints
        (workspace_id, account_id, fan_uuid, kind, ordinal, client_action_id, state)
        SELECT '${workspaceId}', '${accountId}', '${fanUuid}', 'free_gift', ordinal,
          gen_random_uuid(), 'pending'
        FROM generate_series(1, 101) AS ordinal;`);
      const checkpoints = await listFanvueDmCheckpoints(database, {
        workspaceId,
        accountId,
        fanUuid,
      });
      expect(checkpoints).toHaveLength(100);
      expect(checkpoints[0]).toMatchObject({ kind: 'free_gift', ordinal: 1 });
      expect(checkpoints.at(-1)).toMatchObject({ kind: 'free_gift', ordinal: 100 });
    } finally {
      await pg.close();
    }
  });
});
