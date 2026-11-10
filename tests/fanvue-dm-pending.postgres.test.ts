import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import {
  cancelPendingFanvueDm,
  FanvueDmScheduleConflictError,
  scheduleFanvueDm,
} from '../src/modules/providers/fanvue-dm-pending.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000002';
const accountId = '00000000-0000-4000-8000-000000000003';
const input = {
  workspaceId,
  accountId,
  fanUuid: '00000000-0000-4000-8000-000000000004',
  clientActionId: '00000000-0000-4000-8000-000000000005',
  actor: { type: 'api-key' as const, id: '00000000-0000-4000-8000-000000000006' },
  text: 'Scheduled hello',
  dueAt: new Date('2026-11-11T10:00:00Z'),
};

describe('Fanvue DM pending intent foundation', () => {
  it('keeps one immutable tenant-owned schedule and cancels only before claim', async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`
        CREATE TYPE audit_actor_type AS ENUM ('user', 'api_key', 'delegated');
        CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL, destination_provider text NOT NULL,
          PRIMARY KEY (workspace_id,id));
        CREATE TABLE fanvue_action_intents (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, client_action_id uuid NOT NULL);
        INSERT INTO provider_accounts VALUES ('${accountId}','${workspaceId}','fanvue'),
          ('${accountId}','${otherWorkspaceId}','facebook_page');
      `);
      await pg.exec(
        await readFile(
          new URL('../migrations/0111_fanvue_dm_pending_intents.sql', import.meta.url),
          'utf8',
        ),
      );
      const database = drizzle(pg) as unknown as NodePgDatabase;
      const scheduled = await scheduleFanvueDm(database, input);
      expect(scheduled).toMatchObject({ status: 'pending', text: 'Scheduled hello', mediaIds: [] });
      expect((await scheduleFanvueDm(database, input)).id).toBe(scheduled.id);
      await expect(
        scheduleFanvueDm(database, { ...input, text: 'Changed' }),
      ).rejects.toBeInstanceOf(FanvueDmScheduleConflictError);
      await expect(
        scheduleFanvueDm(database, { ...input, workspaceId: otherWorkspaceId }),
      ).rejects.toBeInstanceOf(FanvueDmScheduleConflictError);
      expect(await cancelPendingFanvueDm(database, input)).toBe(true);
      expect(await cancelPendingFanvueDm(database, input)).toBe(false);
      expect((await scheduleFanvueDm(database, input)).status).toBe('cancelled');
      const count = await pg.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM fanvue_dm_pending_intents`,
      );
      expect(count.rows[0]?.count).toBe(1);
    } finally {
      await pg.close();
    }
  });
});
