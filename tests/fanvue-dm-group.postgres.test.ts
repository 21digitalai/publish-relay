import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import {
  cancelFanvueDmGroup,
  claimDueFanvueDm,
  FanvueDmScheduleConflictError,
  finishClaimedFanvueDm,
  getFanvueDmGroupStatus,
  scheduleFanvueDmGroup,
} from '../src/modules/providers/fanvue-dm-pending.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000002';
const accountId = '00000000-0000-4000-8000-000000000003';
const fanUuid = '00000000-0000-4000-8000-000000000004';
const clientActionId = '00000000-0000-4000-8000-000000000005';

async function setup() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TYPE audit_actor_type AS ENUM ('user', 'api_key', 'delegated');
    CREATE TABLE engagement_proposals (workspace_id uuid NOT NULL, client_action_id uuid NOT NULL,
      provider text NOT NULL, kind text NOT NULL, status text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL,
      destination_provider text NOT NULL, PRIMARY KEY (workspace_id,id));
    CREATE TABLE fanvue_action_intents (id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
      client_action_id uuid NOT NULL);
    INSERT INTO provider_accounts VALUES ('${accountId}','${workspaceId}','fanvue'),
      ('${accountId}','${otherWorkspaceId}','fanvue');
  `);
  for (const migration of [
    '0111_fanvue_dm_pending_intents.sql',
    '0112_fanvue_dm_pending_media_preview.sql',
    '0113_fanvue_pending_target_label.sql',
    '0115_fanvue_comment_pending_intents.sql',
    '0126_fanvue_dm_groups.sql',
  ]) {
    await pg.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  return { pg, database: drizzle(pg) as unknown as NodePgDatabase };
}

function command() {
  return {
    workspaceId,
    accountId,
    fanUuid,
    clientActionId,
    actor: {
      type: 'api-key' as const,
      id: '00000000-0000-4000-8000-000000000006',
    },
    bubbles: ['One', 'Two', 'Three', 'Four', 'Five'],
    expectedLatestInboundMessageUuid: '00000000-0000-4000-8000-000000000007',
    expectedLatestInboundAt: new Date('2026-11-20T10:00:00Z'),
    earliestAt: new Date('2026-11-20T10:01:00Z'),
    latestAt: new Date('2026-11-20T12:00:00Z'),
  };
}

describe('Fanvue durable DM groups', () => {
  it('stores one sampled root and four waiting tails with exact replay', async () => {
    const { pg, database } = await setup();
    try {
      const input = command();
      const root = await scheduleFanvueDmGroup(database, input);
      expect(root).toMatchObject({ status: 'pending', sequenceIndex: 0 });
      expect(root.dueAt.getTime()).toBeGreaterThanOrEqual(input.earliestAt.getTime());
      expect(root.dueAt.getTime()).toBeLessThanOrEqual(input.latestAt.getTime());
      expect((await scheduleFanvueDmGroup(database, input)).dueAt).toEqual(root.dueAt);
      await expect(
        scheduleFanvueDmGroup(database, { ...input, bubbles: ['Changed'] }),
      ).rejects.toBeInstanceOf(FanvueDmScheduleConflictError);
      const status = await getFanvueDmGroupStatus(database, input);
      expect(status?.bubbles.map((bubble) => bubble.status)).toEqual([
        'pending',
        'waiting',
        'waiting',
        'waiting',
        'waiting',
      ]);
      const rows = await pg.query<{ sequence_index: number; gap_seconds: number }>(
        `SELECT sequence_index, gap_seconds FROM fanvue_dm_pending_intents ORDER BY sequence_index`,
      );
      expect(rows.rows[0]?.gap_seconds).toBe(0);
      expect(rows.rows.slice(1).every((row) => row.gap_seconds >= 4 && row.gap_seconds <= 10)).toBe(
        true,
      );
    } finally {
      await pg.close();
    }
  });

  it('rejects root action IDs already owned by immediate or comment ledgers', async () => {
    const { pg, database } = await setup();
    try {
      const input = command();
      await pg.query(
        `INSERT INTO fanvue_action_intents (id, workspace_id, client_action_id)
         VALUES ($1, $2, $3)`,
        ['00000000-0000-4000-8000-000000000010', workspaceId, input.clientActionId],
      );
      await expect(scheduleFanvueDmGroup(database, input)).rejects.toBeInstanceOf(
        FanvueDmScheduleConflictError,
      );
      await pg.query('DELETE FROM fanvue_action_intents');
      await pg.query(
        `INSERT INTO fanvue_comment_pending_intents (
          workspace_id, account_id, client_action_id, actor_type, actor_id,
          post_uuid, text_body, due_at
        ) VALUES ($1, $2, $3, 'api_key', $4, $5, 'comment', now())`,
        [
          workspaceId,
          accountId,
          input.clientActionId,
          input.actor.id,
          '00000000-0000-4000-8000-000000000011',
        ],
      );
      await expect(scheduleFanvueDmGroup(database, input)).rejects.toBeInstanceOf(
        FanvueDmScheduleConflictError,
      );
    } finally {
      await pg.close();
    }
  });

  it('cancels only unsent group parts and isolates tenant reads', async () => {
    const { pg, database } = await setup();
    try {
      const input = command();
      await scheduleFanvueDmGroup(database, input);
      await pg.query(
        `UPDATE fanvue_dm_pending_intents SET status = 'confirmed' WHERE workspace_id = $1 AND sequence_index = 0`,
        [workspaceId],
      );
      expect(await cancelFanvueDmGroup(database, input)).toEqual({ cancelled: 4 });
      expect(
        await getFanvueDmGroupStatus(database, { ...input, workspaceId: otherWorkspaceId }),
      ).toBeNull();
    } finally {
      await pg.close();
    }
  });

  it('releases exactly one confirmed tail without applying root account pacing', async () => {
    const { pg, database } = await setup();
    try {
      const input = { ...command(), bubbles: ['Root', 'Tail', 'Last'] };
      await scheduleFanvueDmGroup(database, input);
      const root = await claimDueFanvueDm(database, {
        workerId: 'worker',
        now: new Date('2026-11-20T13:00:00Z'),
        leaseMs: 30_000,
      });
      expect(root?.sequenceIndex).toBe(0);
      expect(
        await finishClaimedFanvueDm(database, {
          workspaceId,
          id: root?.id ?? '',
          leaseOwner: root?.leaseOwner ?? '',
          state: 'confirmed',
        }),
      ).toBe(true);
      const status = await getFanvueDmGroupStatus(database, input);
      expect(status?.bubbles.map((bubble) => bubble.status)).toEqual([
        'confirmed',
        'pending',
        'waiting',
      ]);
      const tail = await claimDueFanvueDm(database, {
        workerId: 'worker',
        now: new Date(Date.now() + 20_000),
        leaseMs: 30_000,
      });
      expect(tail?.sequenceIndex).toBe(1);
    } finally {
      await pg.close();
    }
  });
});
