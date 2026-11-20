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
  it('reserves idempotently, rejects changed ownership and settles once', async () => {
    const { pg, database } = await setup();
    const input = {
      workspaceId,
      accountId,
      fanUuid,
      kind: 'welcome' as const,
      ordinal: 1,
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
        settleFanvueDmCheckpoint(database, {
          ...input,
          state: 'confirmed',
          providerMessageUuid,
        }),
      ).resolves.toMatchObject({ state: 'confirmed', providerMessageUuid });
      await expect(
        settleFanvueDmCheckpoint(database, { ...input, state: 'unknown' }),
      ).rejects.toBeInstanceOf(FanvueDmCheckpointConflictError);
      expect(await listFanvueDmCheckpoints(database, { workspaceId, accountId, fanUuid })).toEqual([
        expect.objectContaining({ kind: 'welcome', ordinal: 1, state: 'confirmed' }),
      ]);
    } finally {
      await pg.close();
    }
  });
});
