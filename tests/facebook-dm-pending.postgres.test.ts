import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';

const sendMock = vi.hoisted(() => vi.fn());
vi.mock('../src/modules/providers/facebook-messenger-send.service.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  sendAccountPageConversationMessage: sendMock,
}));

import {
  cancelPendingPageDm,
  cancelScheduledProposalPageDm,
  claimDuePageDms,
  finishClaimedPageDm,
  getPageDmDelayWindow,
  PendingDmConflictError,
  PendingDmNoGoError,
  isAllowedPageDmGroupDispatchInTransaction,
  renewClaimedPageDm,
  scheduleApprovedPageDm,
  schedulePageDm,
  setPageDmDelayWindow,
} from '../src/modules/providers/facebook-dm-pending.repository.js';
import { setPageConversationNoGo } from '../src/modules/providers/facebook-dm-no-go.repository.js';
import { dispatchDuePageDms } from '../src/modules/providers/facebook-dm-pending.worker.js';
import {
  cancelPageDmGroup,
  getPageDmGroupStatus,
  schedulePageDmGroup,
} from '../src/modules/providers/facebook-dm-group.repository.js';
import { FacebookDmConversationChangedError } from '../src/modules/providers/facebook-messenger-send.service.js';
import { pageDmCivilDay } from '../src/modules/providers/facebook-dm-active-days.repository.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000003';
const actorId = '00000000-0000-4000-8000-000000000004';
const actionId = '00000000-0000-4000-8000-000000000005';

async function setup() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TYPE audit_actor_type AS ENUM ('user', 'api_key', 'delegated', 'system');
    CREATE TABLE workspaces (id uuid PRIMARY KEY);
    CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL,
      destination_provider text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, id));
    CREATE TABLE memberships (workspace_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL);
    CREATE TABLE engagement_proposals (id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
      account_id uuid NOT NULL, client_action_id uuid NOT NULL DEFAULT gen_random_uuid(), provider text NOT NULL, kind text NOT NULL,
      target_id text NOT NULL, source_context jsonb NOT NULL DEFAULT '{}', content jsonb NOT NULL DEFAULT '{}',
      proposer_type text NOT NULL DEFAULT 'api_key', proposer_id uuid NOT NULL DEFAULT gen_random_uuid(),
      status text NOT NULL, revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE facebook_page_dm_actions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL, account_id uuid NOT NULL DEFAULT '${accountId}',
      conversation_id text NOT NULL DEFAULT 't_123', client_action_id uuid NOT NULL,
      request_fingerprint text NOT NULL DEFAULT 'other-request',
      state text NOT NULL DEFAULT 'reserved');
    CREATE TABLE facebook_page_engagement_modules (
      workspace_id uuid NOT NULL, account_id uuid NOT NULL,
      dm_daily_group_limit_enabled boolean NOT NULL DEFAULT false,
      PRIMARY KEY (workspace_id, account_id));
    INSERT INTO workspaces VALUES ('${workspaceId}'), ('${otherWorkspaceId}');
    INSERT INTO provider_accounts VALUES ('${accountId}', '${workspaceId}', 'facebook_page');
  `);
  for (const migration of [
    '0095_facebook_page_dm_no_go.sql',
    '0097_facebook_page_dm_pending_intents.sql',
    '0098_engagement_proposal_planned_due_at.sql',
    '0099_page_dm_pre_send_attempts.sql',
    '0100_page_dm_grouped_approval.sql',
    '0103_facebook_page_dm_memory.sql',
    '0104_page_dm_autonomous_groups.sql',
    '0117_facebook_dm_failure_circuit.sql',
    '0118_facebook_dm_final_exit_receipt.sql',
    '0120_facebook_dm_bio_link_receipt.sql',
    '0122_facebook_dm_window_priority.sql',
  ]) {
    await pg.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  return { pg, database: drizzle(pg) as unknown as NodePgDatabase };
}

describe('Page DM pending intent', () => {
  it('rejects machine single-message scheduling under the Page lock after opt-in', async () => {
    const { pg, database } = await setup();
    try {
      const input = {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: actionId,
        requestFingerprint: 'exact-request',
        text: 'Hello',
        dueAt: new Date(),
        actor: { type: 'api-key' as const, id: actorId },
      };
      await pg.query(
        'INSERT INTO facebook_page_engagement_modules (workspace_id, account_id, dm_daily_group_limit_enabled) VALUES ($1, $2, true)',
        [workspaceId, accountId],
      );
      await expect(schedulePageDm(database, input)).rejects.toThrow(
        'requires a scheduled DM reply group',
      );
      const rows = await pg.query('SELECT id FROM facebook_page_dm_pending_intents');
      expect(rows.rows).toHaveLength(0);
      await expect(
        schedulePageDm(database, {
          ...input,
          actor: { type: 'user', id: actorId },
        }),
      ).resolves.toMatchObject({ status: 'pending' });
    } finally {
      await pg.close();
    }
  });
  it('preserves exact scheduled-action replay across a Page toggle', async () => {
    const { pg, database } = await setup();
    try {
      const input = {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: actionId,
        requestFingerprint: 'exact-request',
        text: 'Hello',
        dueAt: new Date(),
        actor: { type: 'api-key' as const, id: actorId },
      };
      const first = await schedulePageDm(database, input);
      await pg.query(
        'INSERT INTO facebook_page_engagement_modules (workspace_id, account_id, dm_daily_group_limit_enabled) VALUES ($1, $2, true)',
        [workspaceId, accountId],
      );
      expect((await schedulePageDm(database, input)).id).toBe(first.id);
      await expect(schedulePageDm(database, { ...input, text: 'Changed' })).rejects.toBeInstanceOf(
        PendingDmConflictError,
      );
    } finally {
      await pg.close();
    }
  });
  it('recognizes only the exact claimed group bubble as a capped machine send', async () => {
    const { pg, database } = await setup();
    try {
      const group = await schedulePageDmGroup(database, {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: actionId,
        texts: ['Hello'],
        expectedLatestInboundMessageId: 'inbound-1',
        windowDeadline: new Date(Date.now() + 3600_000),
        actor: { type: 'api-key', id: actorId },
      });
      await pg.query(
        "UPDATE facebook_page_dm_pending_intents SET status='claimed', lease_owner='test-worker', lease_until=now() + interval '1 minute' WHERE id=$1",
        [group.id],
      );
      const exact = {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: actionId,
        actor: { type: 'api-key' as const, id: actorId },
        text: 'Hello',
        scheduledIntentId: group.id,
      };
      await withTenantTransaction(database, exact, async (tx) => {
        expect(await isAllowedPageDmGroupDispatchInTransaction(tx, exact)).toBe(true);
        expect(
          await isAllowedPageDmGroupDispatchInTransaction(tx, { ...exact, text: 'Different' }),
        ).toBe(false);
        expect(
          await isAllowedPageDmGroupDispatchInTransaction(tx, {
            ...exact,
            scheduledIntentId: undefined,
          }),
        ).toBe(false);
      });
    } finally {
      await pg.close();
    }
  });
  it('blocks a preexisting second same-day group after the Page cap turns on', async () => {
    const { pg, database } = await setup();
    try {
      const request = {
        workspaceId,
        accountId,
        conversationId: 't_123',
        texts: ['Hello'],
        expectedLatestInboundMessageId: 'inbound-1',
        windowDeadline: new Date(Date.now() + 3600_000),
        actor: { type: 'api-key' as const, id: actorId },
      };
      const first = await schedulePageDmGroup(database, { ...request, clientActionId: actionId });
      await pg.query("UPDATE facebook_page_dm_pending_intents SET status='confirmed' WHERE id=$1", [
        first.id,
      ]);
      const secondActionId = randomUUID();
      const second = await schedulePageDmGroup(database, {
        ...request,
        clientActionId: secondActionId,
        expectedLatestInboundMessageId: 'inbound-2',
      });
      await pg.query(
        "UPDATE facebook_page_dm_pending_intents SET status='claimed', lease_owner='test-worker', lease_until=now() + interval '1 minute' WHERE id=$1",
        [second.id],
      );
      await pg.query(
        'INSERT INTO facebook_page_engagement_modules (workspace_id, account_id, dm_daily_group_limit_enabled) VALUES ($1, $2, true)',
        [workspaceId, accountId],
      );
      const candidate = {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: secondActionId,
        actor: request.actor,
        text: 'Hello',
        scheduledIntentId: second.id,
      };
      await withTenantTransaction(database, candidate, async (tx) => {
        expect(await isAllowedPageDmGroupDispatchInTransaction(tx, candidate)).toBe(false);
      });
    } finally {
      await pg.close();
    }
  });
  it('uses Sofia civil days across midnight and DST', () => {
    expect(pageDmCivilDay(new Date('2026-11-11T21:59:59Z'))).toBe('2026-11-11');
    expect(pageDmCivilDay(new Date('2026-11-11T22:00:00Z'))).toBe('2026-11-12');
    expect(pageDmCivilDay(new Date('2026-03-28T21:59:59Z'))).toBe('2026-03-28');
    expect(pageDmCivilDay(new Date('2026-03-28T22:00:00Z'))).toBe('2026-03-29');
  });
  it('persists final-exit intent only on the last bubble and rejects changed replay', async () => {
    const { pg, database } = await setup();
    try {
      const input = {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: actionId,
        texts: ['Opening', 'Final exit'],
        finalExit: true,
        bioLinkMention: true,
        expectedLatestInboundMessageId: 'inbound-1',
        windowDeadline: new Date(Date.now() + 3600_000),
        actor: { type: 'user' as const, id: actorId },
      };
      const group = await schedulePageDmGroup(database, input);
      const rows = await pg.query<{
        final_exit: boolean;
        bio_link_mention: boolean;
        status: string;
      }>(
        'SELECT final_exit, bio_link_mention, status FROM facebook_page_dm_pending_intents WHERE group_id=$1 ORDER BY sequence_index',
        [group.groupId],
      );
      expect(rows.rows).toEqual([
        { final_exit: false, bio_link_mention: false, status: 'pending' },
        { final_exit: true, bio_link_mention: true, status: 'waiting' },
      ]);
      expect((await schedulePageDmGroup(database, input)).id).toBe(group.id);
      await expect(
        schedulePageDmGroup(database, { ...input, finalExit: false }),
      ).rejects.toBeInstanceOf(PendingDmConflictError);
      await expect(
        schedulePageDmGroup(database, { ...input, bioLinkMention: false }),
      ).rejects.toBeInstanceOf(PendingDmConflictError);
    } finally {
      await pg.close();
    }
  });
  it('does not claim a halted Page and preserves its pending action for owner clearance', async () => {
    const { pg, database } = await setup();
    try {
      await pg.query(
        `INSERT INTO facebook_page_dm_failure_circuit
        (workspace_id, account_id, consecutive_failures, halted_at)
        VALUES ($1, $2, 3, now())`,
        [workspaceId, accountId],
      );
      await pg.query(
        `INSERT INTO facebook_page_dm_pending_intents
        (workspace_id, account_id, conversation_id, client_action_id, request_fingerprint,
         actor_type, actor_id, text_body, due_at)
        VALUES ($1, $2, 't_123', $3, 'fingerprint', 'user', $4, 'Pending', now() - interval '1 minute')`,
        [workspaceId, accountId, actionId, actorId],
      );
      expect(
        await claimDuePageDms(database, {
          workerId: 'w',
          now: new Date(),
          leaseMs: 30_000,
          limit: 1,
        }),
      ).toEqual([]);
      const rows = await pg.query(
        'SELECT status, client_action_id FROM facebook_page_dm_pending_intents',
      );
      expect(rows.rows).toEqual([{ status: 'pending', client_action_id: actionId }]);
      await pg.query(
        'UPDATE facebook_page_dm_failure_circuit SET halted_at=NULL WHERE account_id=$1',
        [accountId],
      );
      expect(
        await claimDuePageDms(database, {
          workerId: 'w',
          now: new Date(),
          leaseMs: 30_000,
          limit: 1,
        }),
      ).toHaveLength(1);
    } finally {
      await pg.close();
    }
  });
  it('passes the reviewed inbound identity to the canonical sender', async () => {
    const { pg, database } = await setup();
    try {
      sendMock.mockReset();
      sendMock.mockResolvedValue({ state: 'confirmed' });
      await pg.query('INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)', [
        workspaceId,
        actorId,
        'owner',
      ]);
      await pg.query(
        `INSERT INTO facebook_page_dm_pending_intents
        (workspace_id, account_id, conversation_id, client_action_id, request_fingerprint,
         actor_type, actor_id, text_body, due_at, group_id, sequence_index, gap_seconds,
         expected_latest_inbound_message_id)
        VALUES ($1, $2, 't_123', $3, 'test', 'user', $4, 'First', $5, $6, 0, 0, 'mid-1')`,
        [
          workspaceId,
          accountId,
          actionId,
          actorId,
          new Date(Date.now() - 1000),
          '00000000-0000-4000-8000-000000000006',
        ],
      );
      // The next waiting bubble is intentionally not claimable until confirmation.
      await pg.query(
        `INSERT INTO facebook_page_dm_pending_intents
        (workspace_id, account_id, conversation_id, client_action_id, request_fingerprint,
         actor_type, actor_id, text_body, due_at, group_id, sequence_index, gap_seconds,
         expected_latest_inbound_message_id, status)
        VALUES ($1, $2, 't_123', $3, 'test-2', 'user', $4, 'Second', $5, $6, 1, 5, 'mid-1', 'waiting')`,
        [
          workspaceId,
          accountId,
          '00000000-0000-4000-8000-000000000007',
          actorId,
          new Date(Date.now() - 1000),
          '00000000-0000-4000-8000-000000000006',
        ],
      );
      const counts = await dispatchDuePageDms({
        database,
        keys: {} as never,
        client: {} as never,
        workerId: 'w',
        leaseMs: 30_000,
      });
      expect(counts.confirmed).toBe(1);
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock.mock.calls[0]?.[1]).toMatchObject({
        expectedLatestInboundMessageId: 'mid-1',
        text: 'First',
      });
      const rows = await pg.query<{ status: string }>(
        'SELECT status FROM facebook_page_dm_pending_intents ORDER BY sequence_index',
      );
      expect(rows.rows.map((row) => row.status)).toEqual(['confirmed', 'pending']);
    } finally {
      await pg.close();
      sendMock.mockReset();
    }
  });

  it('approves one three-bubble plan and releases each tail only after confirmation', async () => {
    const { pg, database } = await setup();
    try {
      const proposalId = '00000000-0000-4000-8000-000000000006';
      const dueAt = new Date(Date.now() + 60_000);
      await pg.query(
        `INSERT INTO engagement_proposals
        (id, workspace_id, account_id, client_action_id, provider, kind, target_id, source_context, content, status, planned_due_at)
        VALUES ($1, $2, $3, $4, 'facebook_page', 'dm', 't_123', $5, $6, 'pending', $7)`,
        [
          proposalId,
          workspaceId,
          accountId,
          actionId,
          JSON.stringify({ sourceMessageId: 'mid-1' }),
          JSON.stringify({ text: 'First', followUps: ['Second', 'Third'] }),
          dueAt,
        ],
      );
      const approved = await scheduleApprovedPageDm(database, {
        workspaceId,
        userId: actorId,
        proposalId,
        expectedRevision: 1,
        previewedAt: new Date(),
        dueAt: new Date(dueAt.getTime() + 300_000),
        windowDeadline: new Date(Date.now() + 60 * 60 * 1000),
        latestInboundMessageId: 'mid-1',
      });
      expect(approved.status).toBe('scheduled');
      const rows = await pg.query<{
        id: string;
        status: string;
        gap_seconds: number;
        expected_latest_inbound_message_id: string;
      }>(
        `SELECT id, status, gap_seconds, expected_latest_inbound_message_id
         FROM facebook_page_dm_pending_intents ORDER BY sequence_index`,
      );
      expect(rows.rows.map((row) => row.status)).toEqual(['pending', 'waiting', 'waiting']);
      expect(rows.rows.every((row) => row.expected_latest_inbound_message_id === 'mid-1')).toBe(
        true,
      );
      expect(rows.rows.slice(1).every((row) => row.gap_seconds >= 4 && row.gap_seconds <= 10)).toBe(
        true,
      );
      const [firstRow, secondRow] = rows.rows;
      if (!firstRow || !secondRow) throw new Error('Grouped intents were not created');
      const firstClaim = await claimDuePageDms(database, {
        workerId: 'w',
        now: approved.dueAt,
        leaseMs: 30_000,
        limit: 3,
      });
      expect(firstClaim).toHaveLength(1);
      await finishClaimedPageDm(database, {
        workspaceId,
        id: firstRow.id,
        workerId: firstClaim[0]?.leaseOwner ?? '',
        state: 'confirmed',
      });
      const second = await pg.query<{ status: string; due_at: Date }>(
        `SELECT status, due_at FROM facebook_page_dm_pending_intents WHERE id = $1`,
        [secondRow.id],
      );
      expect(second.rows[0]?.status).toBe('pending');
      const nextDue = second.rows[0]?.due_at;
      if (!nextDue) throw new Error('Second bubble has no due time');
      expect(new Date(nextDue).getTime()).toBeGreaterThan(Date.now());
      const nextClaim = await claimDuePageDms(database, {
        workerId: 'w',
        now: new Date(Date.now() + 11_000),
        leaseMs: 30_000,
        limit: 3,
      });
      expect(nextClaim.map((row) => row.id)).toEqual([secondRow.id]);
      await finishClaimedPageDm(database, {
        workspaceId,
        id: secondRow.id,
        workerId: nextClaim[0]?.leaseOwner ?? '',
        state: 'unknown',
      });
      const stopped = await pg.query<{ status: string }>(
        `SELECT status FROM facebook_page_dm_pending_intents ORDER BY sequence_index`,
      );
      expect(stopped.rows.map((row) => row.status)).toEqual(['confirmed', 'unknown', 'cancelled']);
      const proposal = await pg.query<{ status: string }>(
        'SELECT status FROM engagement_proposals WHERE id = $1',
        [proposalId],
      );
      expect(proposal.rows[0]?.status).toBe('unknown');
    } finally {
      await pg.close();
    }
  });

  it('fences a stale claim when the same configured worker ID reclaims it', async () => {
    const { pg, database } = await setup();
    try {
      const dueAt = new Date(Date.now() - 5000);
      const intent = await schedulePageDm(database, {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: actionId,
        requestFingerprint: 'fenced',
        actor: { type: 'user', id: actorId },
        text: 'Only once',
        dueAt,
      });
      const [oldClaim] = await claimDuePageDms(database, {
        workerId: 'same-worker',
        now: dueAt,
        leaseMs: 1000,
        limit: 1,
      });
      const [newClaim] = await claimDuePageDms(database, {
        workerId: 'same-worker',
        now: new Date(dueAt.getTime() + 1001),
        leaseMs: 30_000,
        limit: 1,
      });
      expect(oldClaim?.leaseOwner).toBeTruthy();
      expect(newClaim?.leaseOwner).toBeTruthy();
      expect(newClaim?.leaseOwner).not.toBe(oldClaim?.leaseOwner);
      expect(
        await renewClaimedPageDm(database, {
          workspaceId,
          id: intent.id,
          workerId: oldClaim?.leaseOwner ?? '',
          leaseMs: 30_000,
        }),
      ).toBe(false);
      expect(
        await finishClaimedPageDm(database, {
          workspaceId,
          id: intent.id,
          workerId: oldClaim?.leaseOwner ?? '',
          state: 'pending',
        }),
      ).toBe(false);
      const rows = await pg.query<{
        status: string;
        lease_owner: string;
        pre_send_attempts: number;
      }>(
        'SELECT status, lease_owner, pre_send_attempts FROM facebook_page_dm_pending_intents WHERE id = $1',
        [intent.id],
      );
      expect(rows.rows[0]).toMatchObject({
        status: 'claimed',
        lease_owner: newClaim?.leaseOwner,
        pre_send_attempts: 0,
      });
      expect(
        await finishClaimedPageDm(database, {
          workspaceId,
          id: intent.id,
          workerId: newClaim?.leaseOwner ?? '',
          state: 'failed',
        }),
      ).toBe(true);
    } finally {
      await pg.close();
    }
  });

  it('persists a selected Page delay default and cancels only its pending proposal', async () => {
    const { pg, database } = await setup();
    try {
      expect(await getPageDmDelayWindow(database, { workspaceId, accountId })).toEqual({
        earliestDelaySeconds: 300,
        latestDelaySeconds: 2700,
      });
      await setPageDmDelayWindow(database, {
        workspaceId,
        accountId,
        earliestDelaySeconds: 600,
        latestDelaySeconds: 5400,
      });
      expect(await getPageDmDelayWindow(database, { workspaceId, accountId })).toEqual({
        earliestDelaySeconds: 600,
        latestDelaySeconds: 5400,
      });
      const intent = await schedulePageDm(database, {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: actionId,
        requestFingerprint: 'test',
        actor: { type: 'user', id: actorId },
        text: 'Later',
        dueAt: new Date('2026-11-05T12:00:00.000Z'),
      });
      const proposalId = '00000000-0000-4000-8000-000000000006';
      await pg.exec(`INSERT INTO engagement_proposals (id, workspace_id, account_id, client_action_id, provider, kind, target_id, status)
        VALUES ('${proposalId}', '${workspaceId}', '${accountId}', '${actionId}', 'facebook_page', 'dm', 't_123', 'scheduled')`);
      expect(
        await cancelScheduledProposalPageDm(database, {
          workspaceId: otherWorkspaceId,
          proposalId,
        }),
      ).toBe(false);
      expect(await cancelScheduledProposalPageDm(database, { workspaceId, proposalId })).toBe(true);
      expect(await cancelScheduledProposalPageDm(database, { workspaceId, proposalId })).toBe(
        false,
      );
      const rows = await pg.query<{ status: string }>(
        `SELECT status FROM facebook_page_dm_pending_intents WHERE id = '${intent.id}'`,
      );
      expect(rows.rows[0]?.status).toBe('cancelled');
      const proposals = await pg.query<{ status: string }>(
        `SELECT status FROM engagement_proposals WHERE id = '${proposalId}'`,
      );
      expect(proposals.rows[0]?.status).toBe('cancelled');
    } finally {
      await pg.close();
    }
  });

  it('settles a previously reserved provider action as unknown without any Meta call', async () => {
    const { pg, database } = await setup();
    try {
      const dueAt = new Date('2026-11-05T10:00:00.000Z');
      await schedulePageDm(database, {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: actionId,
        requestFingerprint: 'scheduled-request',
        actor: { type: 'user', id: actorId },
        text: 'Once',
        dueAt,
      });
      await pg.exec(`INSERT INTO facebook_page_dm_actions (workspace_id, client_action_id)
        VALUES ('${workspaceId}', '${actionId}')`);
      const counts = await dispatchDuePageDms(
        {
          database,
          keys: {} as never,
          client: {} as never,
          workerId: 'worker-a',
          leaseMs: 30_000,
        },
        dueAt,
      );
      expect(counts).toEqual({ confirmed: 0, failed: 0, unknown: 1, pending: 0 });
      const rows = await pg.query<{ status: string }>(
        'SELECT status FROM facebook_page_dm_pending_intents',
      );
      expect(rows.rows[0]?.status).toBe('unknown');
    } finally {
      await pg.close();
    }
  });
  it('rechecks actor membership at due time and never calls Meta after revocation', async () => {
    const { pg, database } = await setup();
    try {
      await schedulePageDm(database, {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: actionId,
        requestFingerprint: 'revoked-actor',
        actor: { type: 'user', id: actorId },
        text: 'No send',
        dueAt: new Date('2026-11-05T10:00:00.000Z'),
      });
      const counts = await dispatchDuePageDms(
        {
          database,
          keys: {} as never,
          client: {} as never,
          workerId: 'worker-a',
          leaseMs: 30_000,
        },
        new Date('2026-11-05T10:00:00.000Z'),
      );
      expect(counts).toEqual({ confirmed: 0, failed: 1, unknown: 0, pending: 0 });
      const rows = await pg.query<{ status: string }>(
        'SELECT status FROM facebook_page_dm_pending_intents',
      );
      expect(rows.rows[0]?.status).toBe('failed');
    } finally {
      await pg.close();
    }
  });
  it('keeps one immutable action, isolates cancellation, and claims due work once', async () => {
    const { pg, database } = await setup();
    try {
      const dueAt = new Date('2026-11-05T10:00:00.000Z');
      const input = {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: actionId,
        requestFingerprint: 'same-request',
        actor: { type: 'user' as const, id: actorId },
        text: 'Здравей',
        dueAt,
      };
      const first = await schedulePageDm(database, input);
      expect((await schedulePageDm(database, input)).id).toBe(first.id);
      await expect(
        schedulePageDm(database, { ...input, text: 'different' }),
      ).rejects.toBeInstanceOf(PendingDmConflictError);
      expect(
        await cancelPendingPageDm(database, {
          workspaceId: otherWorkspaceId,
          accountId,
          conversationId: input.conversationId,
          id: first.id,
        }),
      ).toBe(false);
      const claimed = await claimDuePageDms(database, {
        workerId: 'worker-a',
        now: dueAt,
        leaseMs: 30_000,
        limit: 10,
      });
      expect(claimed.map((row) => row.id)).toEqual([first.id]);
      expect(
        await cancelPendingPageDm(database, {
          workspaceId,
          accountId,
          conversationId: input.conversationId,
          id: first.id,
        }),
      ).toBe(false);
      expect(
        await claimDuePageDms(database, {
          workerId: 'worker-b',
          now: dueAt,
          leaseMs: 30_000,
          limit: 10,
        }),
      ).toEqual([]);
      await pg.exec(`INSERT INTO facebook_page_dm_actions (workspace_id, client_action_id)
        VALUES ('${workspaceId}', '${actionId}')`);
      await expect(
        finishClaimedPageDm(database, {
          workspaceId,
          id: first.id,
          workerId: claimed[0]?.leaseOwner ?? '',
          state: 'pending',
        }),
      ).rejects.toThrow('Cannot retry');
      expect(
        await finishClaimedPageDm(database, {
          workspaceId,
          id: first.id,
          workerId: claimed[0]?.leaseOwner ?? '',
          state: 'unknown',
        }),
      ).toBe(true);
    } finally {
      await pg.close();
    }
  });

  it('renews one active lease and bounds pre-send retries without reserving an action', async () => {
    const { pg, database } = await setup();
    try {
      const dueAt = new Date(Date.now() - 1000);
      const first = await schedulePageDm(database, {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: actionId,
        requestFingerprint: 'same-request',
        actor: { type: 'user', id: actorId },
        text: 'Later',
        dueAt,
      });
      let now = new Date();
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const [claim] = await claimDuePageDms(database, {
          workerId: 'worker-a',
          now,
          leaseMs: 1000,
          limit: 1,
        });
        expect(claim?.id).toBe(first.id);
        if (attempt === 1) {
          expect(
            await renewClaimedPageDm(database, {
              workspaceId,
              id: first.id,
              workerId: claim?.leaseOwner ?? '',
              leaseMs: 60_000,
            }),
          ).toBe(true);
          expect(
            await claimDuePageDms(database, {
              workerId: 'worker-b',
              now: new Date(Date.now() + 500),
              leaseMs: 1000,
              limit: 1,
            }),
          ).toEqual([]);
        }
        expect(
          await finishClaimedPageDm(database, {
            workspaceId,
            id: first.id,
            workerId: claim?.leaseOwner ?? '',
            state: 'pending',
          }),
        ).toBe(true);
        const result = await pg.query<{
          status: string;
          due_at: string;
          pre_send_attempts: number;
        }>('SELECT status, due_at, pre_send_attempts FROM facebook_page_dm_pending_intents');
        expect(result.rows[0]?.pre_send_attempts).toBe(attempt);
        expect(result.rows[0]?.status).toBe(attempt === 3 ? 'failed' : 'pending');
        now = new Date(Date.parse(result.rows[0]?.due_at ?? '') + 1000);
      }
      expect((await pg.query('SELECT * FROM facebook_page_dm_actions')).rows).toHaveLength(0);
    } finally {
      await pg.close();
    }
  });

  it('retries a transient pre-reservation read failure then confirms once', async () => {
    const { pg, database } = await setup();
    try {
      await pg.exec(`INSERT INTO memberships VALUES ('${workspaceId}', '${actorId}', 'admin')`);
      await schedulePageDm(database, {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: actionId,
        requestFingerprint: 'same-request',
        actor: { type: 'user', id: actorId },
        text: 'Later',
        dueAt: new Date(Date.now() - 1000),
      });
      const runtime = {
        database,
        keys: {} as never,
        client: {} as never,
        workerId: 'worker-a',
        leaseMs: 30_000,
      };
      sendMock
        .mockReset()
        .mockRejectedValueOnce(new Error('temporary Meta read outage'))
        .mockResolvedValueOnce({ state: 'confirmed', messageId: 'mid_123' });
      expect((await dispatchDuePageDms(runtime)).pending).toBe(1);
      const [pending] = (
        await pg.query<{ status: string; due_at: string }>(
          'SELECT status, due_at FROM facebook_page_dm_pending_intents',
        )
      ).rows;
      expect(pending?.status).toBe('pending');
      expect(
        (await dispatchDuePageDms(runtime, new Date(Date.parse(pending?.due_at ?? '') + 1000)))
          .confirmed,
      ).toBe(1);
      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(
        (await pg.query<{ status: string }>('SELECT status FROM facebook_page_dm_pending_intents'))
          .rows[0]?.status,
      ).toBe('confirmed');
    } finally {
      await pg.close();
    }
  });

  it('does not let another worker reclaim a slow in-flight send after the first lease expires', async () => {
    const { pg, database } = await setup();
    try {
      await pg.exec(`INSERT INTO memberships VALUES ('${workspaceId}', '${actorId}', 'admin')`);
      await schedulePageDm(database, {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: actionId,
        requestFingerprint: 'same-request',
        actor: { type: 'user', id: actorId },
        text: 'Later',
        dueAt: new Date(Date.now() - 1000),
      });
      let releaseSend: (() => void) | undefined;
      sendMock.mockReset().mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSend = () => {
              resolve({ state: 'confirmed', messageId: 'mid_123' });
            };
          }),
      );
      const dispatch = dispatchDuePageDms({
        database,
        keys: {} as never,
        client: {} as never,
        workerId: 'worker-a',
        leaseMs: 300,
      });
      await vi.waitFor(() => {
        expect(sendMock).toHaveBeenCalledOnce();
      });
      await new Promise((resolve) => setTimeout(resolve, 380));
      expect(
        await claimDuePageDms(database, {
          workerId: 'worker-b',
          now: new Date(),
          leaseMs: 300,
          limit: 1,
        }),
      ).toEqual([]);
      releaseSend?.();
      expect((await dispatch).confirmed).toBe(1);
      expect(sendMock).toHaveBeenCalledOnce();
    } finally {
      await pg.close();
    }
  });

  it('rejects a newly blocked recipient and permits cancellation before claim', async () => {
    const { pg, database } = await setup();
    try {
      const input = {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: actionId,
        requestFingerprint: 'same-request',
        actor: { type: 'user' as const, id: actorId },
        text: 'Здравей',
        dueAt: new Date('2026-11-05T10:00:00.000Z'),
      };
      await setPageConversationNoGo(database, { ...input, blocked: true });
      await expect(schedulePageDm(database, input)).rejects.toBeInstanceOf(PendingDmNoGoError);
      await setPageConversationNoGo(database, { ...input, blocked: false });
      const row = await schedulePageDm(database, input);
      expect(
        await cancelPendingPageDm(database, {
          workspaceId,
          accountId,
          conversationId: input.conversationId,
          id: row.id,
        }),
      ).toBe(true);
      expect(
        await claimDuePageDms(database, {
          workerId: 'worker-a',
          now: input.dueAt,
          leaseMs: 30_000,
          limit: 10,
        }),
      ).toEqual([]);
    } finally {
      await pg.close();
    }
  });

  it.each([1, 2, 3, 4])(
    'arms exactly %i bubbles atomically and replays the root',
    async (count) => {
      const { pg, database } = await setup();
      try {
        const input = {
          workspaceId,
          accountId,
          conversationId: 't_123',
          clientActionId: actionId,
          texts: Array.from({ length: count }, (_, index) => `Bubble ${String(index)}`),
          expectedLatestInboundMessageId: 'inbound-1',
          windowDeadline: new Date(Date.now() + 3600_000),
          actor: { type: 'user' as const, id: actorId },
        };
        const first = await schedulePageDmGroup(database, input);
        const next = await schedulePageDmGroup(database, {
          ...input,
          conversationId: 't_456',
          clientActionId: randomUUID(),
        });
        const gapSeconds = (next.dueAt.getTime() - first.dueAt.getTime()) / 1000;
        expect(gapSeconds).toBeGreaterThanOrEqual(60);
        expect(gapSeconds).toBeLessThanOrEqual(120);
        expect((await schedulePageDmGroup(database, input)).id).toBe(first.id);
        await expect(
          schedulePageDmGroup(database, { ...input, texts: ['Different', 'Reply'] }),
        ).rejects.toBeInstanceOf(PendingDmConflictError);
        const rows = await pg.query<{
          status: string;
          gap_seconds: number;
          expected_latest_inbound_message_id: string;
        }>(
          'SELECT status, gap_seconds, expected_latest_inbound_message_id FROM facebook_page_dm_pending_intents WHERE group_id = $1 ORDER BY sequence_index',
          [first.groupId],
        );
        expect(rows.rows.map((row) => row.status)).toEqual([
          'pending',
          ...Array.from({ length: count - 1 }, () => 'waiting'),
        ]);
        expect(
          rows.rows.every((row) => row.expected_latest_inbound_message_id === 'inbound-1'),
        ).toBe(true);
        expect(
          rows.rows.slice(1).every((row) => row.gap_seconds >= 4 && row.gap_seconds <= 10),
        ).toBe(true);
        const status = await getPageDmGroupStatus(database, {
          workspaceId,
          accountId,
          conversationId: 't_123',
          rootId: first.id,
        });
        expect(status?.bubbles).toHaveLength(count);
        expect(
          await getPageDmGroupStatus(database, {
            workspaceId: otherWorkspaceId,
            accountId,
            conversationId: 't_123',
            rootId: first.id,
          }),
        ).toBeNull();
      } finally {
        await pg.close();
      }
    },
  );

  it('limits enabled Pages to one Sofia-day group and preserves inbound idempotence after cancellation', async () => {
    const { pg, database } = await setup();
    try {
      await pg.query('INSERT INTO facebook_page_engagement_modules VALUES ($1,$2,true)', [
        workspaceId,
        accountId,
      ]);
      const base = {
        workspaceId,
        accountId,
        conversationId: 'daily-person',
        texts: ['Hello'],
        expectedLatestInboundMessageId: 'inbound-1',
        windowDeadline: new Date(Date.now() + 3600_000),
        actor: { type: 'api-key' as const, id: actorId },
      };
      const first = await schedulePageDmGroup(database, { ...base, clientActionId: randomUUID() });
      await expect(
        schedulePageDmGroup(database, {
          ...base,
          clientActionId: randomUUID(),
          expectedLatestInboundMessageId: 'inbound-2',
        }),
      ).rejects.toBeInstanceOf(PendingDmConflictError);
      await cancelPageDmGroup(database, {
        workspaceId,
        accountId,
        conversationId: base.conversationId,
        rootId: first.id,
      });
      await expect(
        schedulePageDmGroup(database, {
          ...base,
          clientActionId: randomUUID(),
        }),
      ).rejects.toThrow('This inbound already has a Page DM group');
      const second = await schedulePageDmGroup(database, {
        ...base,
        clientActionId: randomUUID(),
        expectedLatestInboundMessageId: 'inbound-2',
      });
      await pg.query("UPDATE facebook_page_dm_pending_intents SET status='confirmed' WHERE id=$1", [
        second.id,
      ]);
      await expect(
        schedulePageDmGroup(database, {
          ...base,
          clientActionId: randomUUID(),
          expectedLatestInboundMessageId: 'inbound-3',
        }),
      ).rejects.toThrow('One Page DM group per Sofia day');
      const otherAccount = randomUUID();
      await pg.query('INSERT INTO provider_accounts VALUES ($1,$2,$3)', [
        otherAccount,
        workspaceId,
        'facebook_page',
      ]);
      await pg.query('INSERT INTO facebook_page_engagement_modules VALUES ($1,$2,true)', [
        workspaceId,
        otherAccount,
      ]);
      await schedulePageDmGroup(database, {
        ...base,
        accountId: otherAccount,
        clientActionId: randomUUID(),
      });
    } finally {
      await pg.close();
    }
  });

  it('serializes competing action IDs for one enabled Page conversation', async () => {
    const { pg, database } = await setup();
    try {
      await pg.query('INSERT INTO facebook_page_engagement_modules VALUES ($1,$2,true)', [
        workspaceId,
        accountId,
      ]);
      const input = {
        workspaceId,
        accountId,
        conversationId: 'race-person',
        texts: ['Reply'],
        expectedLatestInboundMessageId: 'race-inbound',
        windowDeadline: new Date(Date.now() + 3600_000),
        actor: { type: 'api-key' as const, id: actorId },
      };
      const outcomes = await Promise.allSettled(
        [1, 2].map(() =>
          schedulePageDmGroup(database, {
            ...input,
            clientActionId: randomUUID(),
          }),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const roots = await pg.query(
        "SELECT id FROM facebook_page_dm_pending_intents WHERE sequence_index=0 AND conversation_id='race-person'",
      );
      expect(roots.rows).toHaveLength(1);
    } finally {
      await pg.close();
    }
  });

  it('dispatches a one-bubble group through the guarded due worker without a tail', async () => {
    const { pg, database } = await setup();
    try {
      sendMock.mockReset();
      sendMock.mockResolvedValue({ state: 'confirmed', messageId: 'provider-1' });
      await pg.query('INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)', [
        workspaceId,
        actorId,
        'owner',
      ]);
      const group = await schedulePageDmGroup(database, {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: actionId,
        texts: ['A short reply'],
        expectedLatestInboundMessageId: 'inbound-1',
        windowDeadline: new Date(Date.now() + 3600_000),
        actor: { type: 'user', id: actorId },
      });
      await pg.query(
        "UPDATE facebook_page_dm_pending_intents SET due_at = now() - interval '1 second' WHERE id = $1",
        [group.id],
      );
      const counts = await dispatchDuePageDms({
        database,
        keys: {} as never,
        client: {} as never,
        workerId: 'w',
        leaseMs: 30_000,
      });
      expect(counts.confirmed).toBe(1);
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock.mock.calls[0]?.[1]).toMatchObject({
        text: 'A short reply',
        expectedLatestInboundMessageId: 'inbound-1',
      });
      const status = await getPageDmGroupStatus(database, {
        workspaceId,
        accountId,
        conversationId: 't_123',
        rootId: group.id,
      });
      expect(status?.bubbles.map((bubble) => bubble.status)).toEqual(['confirmed']);
    } finally {
      await pg.close();
      sendMock.mockReset();
    }
  });

  it('fails an enabled Page root that slipped into the next Sofia day without provider I/O', async () => {
    const { pg, database } = await setup();
    try {
      sendMock.mockReset();
      await pg.query('INSERT INTO facebook_page_engagement_modules VALUES ($1,$2,true)', [
        workspaceId,
        accountId,
      ]);
      const group = await schedulePageDmGroup(database, {
        workspaceId,
        accountId,
        conversationId: 'stale-day',
        clientActionId: randomUUID(),
        texts: ['Reply'],
        expectedLatestInboundMessageId: 'inbound-stale',
        windowDeadline: new Date(Date.now() + 3600_000),
        actor: { type: 'user', id: actorId },
      });
      await pg.query(
        "UPDATE facebook_page_dm_pending_intents SET due_at = now() - interval '2 days' WHERE id=$1",
        [group.id],
      );
      const counts = await dispatchDuePageDms({
        database,
        keys: {} as never,
        client: {} as never,
        workerId: 'w',
        leaseMs: 30_000,
      });
      expect(counts.failed).toBe(1);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      await pg.close();
    }
  });

  it('cancels unsent tails after changed inbound and supports explicit group cancellation', async () => {
    const { pg, database } = await setup();
    try {
      await pg.query('INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)', [
        workspaceId,
        actorId,
        'owner',
      ]);
      const input = {
        workspaceId,
        accountId,
        conversationId: 't_123',
        clientActionId: actionId,
        texts: ['First', 'Second', 'Third', 'Fourth'],
        expectedLatestInboundMessageId: 'inbound-1',
        windowDeadline: new Date(Date.now() + 3600_000),
        actor: { type: 'user' as const, id: actorId },
      };
      const group = await schedulePageDmGroup(database, input);
      expect(
        (
          await cancelPageDmGroup(database, {
            workspaceId,
            accountId,
            conversationId: 't_123',
            rootId: group.id,
          })
        )?.cancelled,
      ).toBe(4);
      const second = await schedulePageDmGroup(database, {
        ...input,
        clientActionId: randomUUID(),
      });
      await pg.query(
        "UPDATE facebook_page_dm_pending_intents SET due_at = now() - interval '1 minute' WHERE id = $1",
        [second.id],
      );
      sendMock.mockReset();
      sendMock.mockRejectedValueOnce(new FacebookDmConversationChangedError());
      await dispatchDuePageDms({
        database,
        keys: {} as never,
        client: {} as never,
        workerId: 'w',
        leaseMs: 30_000,
      });
      const rows = await pg.query<{ status: string }>(
        'SELECT status FROM facebook_page_dm_pending_intents WHERE group_id = $1 ORDER BY sequence_index',
        [second.groupId],
      );
      expect(rows.rows.map((row) => row.status)).toEqual([
        'failed',
        'cancelled',
        'cancelled',
        'cancelled',
      ]);
      expect(sendMock).toHaveBeenCalledTimes(1);
    } finally {
      await pg.close();
      sendMock.mockReset();
    }
  });

  it('paces overdue Page roots durably but permits a confirmed group tail', async () => {
    const { pg, database } = await setup();
    try {
      const first = await schedulePageDmGroup(database, {
        workspaceId,
        accountId,
        conversationId: 't_1',
        clientActionId: actionId,
        texts: ['One', 'Two'],
        expectedLatestInboundMessageId: 'inbound-1',
        windowDeadline: new Date(Date.now() + 3600_000),
        actor: { type: 'user', id: actorId },
      });
      const second = await schedulePageDmGroup(database, {
        workspaceId,
        accountId,
        conversationId: 't_2',
        clientActionId: randomUUID(),
        texts: ['Three', 'Four'],
        expectedLatestInboundMessageId: 'inbound-2',
        windowDeadline: new Date(Date.now() + 3600_000),
        actor: { type: 'user', id: actorId },
      });
      await pg.exec(
        "UPDATE facebook_page_dm_pending_intents SET due_at = now() - interval '1 minute' WHERE status = 'pending'",
      );
      const now = new Date();
      const claim = await claimDuePageDms(database, {
        workerId: 'w',
        now,
        leaseMs: 30_000,
        limit: 1,
      });
      expect(claim).toHaveLength(1);
      if (!claim[0]?.leaseOwner) throw new Error('Expected a claimed root');
      await finishClaimedPageDm(database, {
        workspaceId,
        id: claim[0].id,
        workerId: claim[0].leaseOwner,
        state: 'confirmed',
      });
      await pg.exec(
        "UPDATE facebook_page_dm_pending_intents SET due_at = now() - interval '1 second' WHERE status = 'pending' AND sequence_index > 0",
      );
      const tail = await claimDuePageDms(database, {
        workerId: 'w',
        now: new Date(),
        leaseMs: 30_000,
        limit: 1,
      });
      expect(tail[0]?.sequenceIndex).toBe(1);
      if (!tail[0]?.leaseOwner) throw new Error('Expected a claimed tail');
      await finishClaimedPageDm(database, {
        workspaceId,
        id: tail[0].id,
        workerId: tail[0].leaseOwner,
        state: 'confirmed',
      });
      expect(
        await claimDuePageDms(database, {
          workerId: 'w',
          now: new Date(),
          leaseMs: 30_000,
          limit: 1,
        }),
      ).toEqual([]);
      const later = await claimDuePageDms(database, {
        workerId: 'w',
        now: new Date(now.getTime() + 121_000),
        leaseMs: 30_000,
        limit: 1,
      });
      expect(later[0]?.id).toBe(claim[0].id === first.id ? second.id : first.id);
      expect(first.id).not.toBe(second.id);
    } finally {
      await pg.close();
    }
  });

  it('moves a later-discovered near-expiry root ahead of unclaimed younger windows without a burst', async () => {
    const { pg, database } = await setup();
    try {
      const schedule = (conversationId: string, hours: number) =>
        schedulePageDmGroup(database, {
          workspaceId,
          accountId,
          conversationId,
          clientActionId: randomUUID(),
          texts: ['Reply'],
          expectedLatestInboundMessageId: `inbound-${conversationId}`,
          windowDeadline: new Date(Date.now() + hours * 3600_000),
          actor: { type: 'api-key', id: actorId },
        });
      const youngerA = await schedule('younger-a', 3);
      const youngerB = await schedule('younger-b', 4);
      // Appending behind two 60–120-second slots would miss this window.
      const urgent = await schedule('urgent', 150 / 3600);
      const rows = await pg.query<{ id: string; due_at: Date }>(
        'SELECT id, due_at FROM facebook_page_dm_pending_intents WHERE sequence_index=0 ORDER BY due_at',
      );
      expect(rows.rows.map((row) => row.id)).toEqual([urgent.id, youngerA.id, youngerB.id]);
      const [firstRoot, secondRoot] = rows.rows;
      if (!firstRoot || !secondRoot) throw new Error('Expected prioritized roots');
      const firstAt = new Date(new Date(firstRoot.due_at).getTime() + 1000);
      const claimed = await claimDuePageDms(database, {
        workerId: 'priority-worker',
        now: firstAt,
        leaseMs: 30_000,
        limit: 1,
      });
      expect(claimed[0]?.id).toBe(urgent.id);
      expect(
        await claimDuePageDms(database, {
          workerId: 'priority-worker',
          now: firstAt,
          leaseMs: 30_000,
          limit: 1,
        }),
      ).toEqual([]);
      expect(
        new Date(secondRoot.due_at).getTime() - new Date(firstRoot.due_at).getTime(),
      ).toBeGreaterThanOrEqual(60_000);
    } finally {
      await pg.close();
    }
  });

  it('keeps normal non-urgent Page root order and due times stable', async () => {
    const { pg, database } = await setup();
    try {
      const schedule = (conversationId: string, hours: number) =>
        schedulePageDmGroup(database, {
          workspaceId,
          accountId,
          conversationId,
          clientActionId: randomUUID(),
          texts: ['Reply'],
          expectedLatestInboundMessageId: `inbound-${conversationId}`,
          windowDeadline: new Date(Date.now() + hours * 3600_000),
          actor: { type: 'api-key', id: actorId },
        });
      const first = await schedule('first-normal', 1);
      const second = await schedule('second-normal', 2);
      const firstDue = first.dueAt.getTime();
      const secondDue = second.dueAt.getTime();
      const third = await schedule('third-normal', 3);
      const roots = await pg.query<{ id: string; due_at: Date }>(
        'SELECT id, due_at FROM facebook_page_dm_pending_intents WHERE sequence_index=0 ORDER BY due_at',
      );
      expect(roots.rows.map((root) => root.id)).toEqual([first.id, second.id, third.id]);
      expect(new Date(roots.rows[0]?.due_at ?? 0).getTime()).toBe(firstDue);
      expect(new Date(roots.rows[1]?.due_at ?? 0).getTime()).toBe(secondDue);
    } finally {
      await pg.close();
    }
  });

  it('uses a free paced gap ahead of a legacy root without moving its unknown window', async () => {
    const { pg, database } = await setup();
    try {
      const legacy = await schedulePageDmGroup(database, {
        workspaceId,
        accountId,
        conversationId: 'legacy',
        clientActionId: randomUUID(),
        texts: ['Reply'],
        expectedLatestInboundMessageId: 'legacy-inbound',
        windowDeadline: new Date(Date.now() + 3600_000),
        actor: { type: 'api-key', id: actorId },
      });
      const legacyDue = new Date(Date.now() + 20 * 60_000);
      await pg.query(
        'UPDATE facebook_page_dm_pending_intents SET due_at=$1, window_deadline=NULL WHERE id=$2',
        [legacyDue, legacy.id],
      );
      const urgent = await schedulePageDmGroup(database, {
        workspaceId,
        accountId,
        conversationId: 'gap-urgent',
        clientActionId: randomUUID(),
        texts: ['Reply'],
        expectedLatestInboundMessageId: 'gap-inbound',
        windowDeadline: new Date(Date.now() + 10 * 60_000),
        actor: { type: 'api-key', id: actorId },
      });
      expect(urgent.dueAt.getTime() + 60_000).toBeLessThanOrEqual(legacyDue.getTime());
      const row = await pg.query<{ due_at: Date }>(
        'SELECT due_at FROM facebook_page_dm_pending_intents WHERE id=$1',
        [legacy.id],
      );
      expect(new Date(row.rows[0]?.due_at ?? 0).getTime()).toBe(legacyDue.getTime());
    } finally {
      await pg.close();
    }
  });

  it('serializes competing priority insertions under the Page lock', async () => {
    const { pg, database } = await setup();
    try {
      const schedule = (conversationId: string, hours: number) =>
        schedulePageDmGroup(database, {
          workspaceId,
          accountId,
          conversationId,
          clientActionId: randomUUID(),
          texts: ['Reply'],
          expectedLatestInboundMessageId: `inbound-${conversationId}`,
          windowDeadline: new Date(Date.now() + hours * 3600_000),
          actor: { type: 'api-key', id: actorId },
        });
      const younger = await schedule('concurrent-younger', 4);
      const [urgent, medium] = await Promise.all([
        schedule('concurrent-urgent', 2),
        schedule('concurrent-medium', 3),
      ]);
      const rows = await pg.query<{ id: string }>(
        'SELECT id FROM facebook_page_dm_pending_intents WHERE sequence_index=0 ORDER BY due_at',
      );
      expect(rows.rows.map((row) => row.id)).toEqual([urgent.id, medium.id, younger.id]);
    } finally {
      await pg.close();
    }
  });

  it('does not jump ahead of an existing root with an even earlier window', async () => {
    const { pg, database } = await setup();
    try {
      const schedule = (conversationId: string, hours: number) =>
        schedulePageDmGroup(database, {
          workspaceId,
          accountId,
          conversationId,
          clientActionId: randomUUID(),
          texts: ['Reply'],
          expectedLatestInboundMessageId: `inbound-${conversationId}`,
          windowDeadline: new Date(Date.now() + hours * 3600_000),
          actor: { type: 'api-key', id: actorId },
        });
      const earliest = await schedule('earliest-window', 1);
      const later = await schedule('later-window', 4);
      await pg.query('UPDATE facebook_page_dm_pending_intents SET due_at=$1 WHERE id=$2', [
        new Date(Date.now() + 10 * 60_000),
        earliest.id,
      ]);
      await pg.query('UPDATE facebook_page_dm_pending_intents SET due_at=$1 WHERE id=$2', [
        new Date(Date.now() + 11 * 60_000),
        later.id,
      ]);
      const middle = await schedule('middle-window', 3);
      const rows = await pg.query<{ id: string }>(
        'SELECT id FROM facebook_page_dm_pending_intents WHERE sequence_index=0 ORDER BY due_at',
      );
      expect(rows.rows.map((row) => row.id)).toEqual([earliest.id, middle.id, later.id]);
    } finally {
      await pg.close();
    }
  });

  it('holds an urgent root when safe reordering cannot fit another window', async () => {
    const { pg, database } = await setup();
    try {
      const common = {
        workspaceId,
        accountId,
        texts: ['Reply'],
        actor: { type: 'api-key' as const, id: actorId },
      };
      await schedulePageDmGroup(database, {
        ...common,
        conversationId: 'first',
        clientActionId: randomUUID(),
        expectedLatestInboundMessageId: 'first-inbound',
        windowDeadline: new Date(Date.now() + 3600_000),
      });
      await expect(
        schedulePageDmGroup(database, {
          ...common,
          conversationId: 'second',
          clientActionId: randomUUID(),
          expectedLatestInboundMessageId: 'second-inbound',
          windowDeadline: new Date(Date.now() + 30_000),
        }),
      ).rejects.toThrow('eligible paced Page DM slot');
      const rows = await pg.query(
        'SELECT conversation_id FROM facebook_page_dm_pending_intents WHERE sequence_index=0',
      );
      expect(rows.rows).toHaveLength(1);
    } finally {
      await pg.close();
    }
  });

  it('uses the earliest paced slot when an existing root is too close to leave a gap', async () => {
    const { pg, database } = await setup();
    try {
      const older = await schedulePageDmGroup(database, {
        workspaceId,
        accountId,
        conversationId: 'young-window',
        clientActionId: randomUUID(),
        texts: ['Reply'],
        expectedLatestInboundMessageId: 'young-inbound',
        windowDeadline: new Date(Date.now() + 3600_000),
        actor: { type: 'api-key', id: actorId },
      });
      const nearDue = new Date(Date.now() + 100_000);
      await pg.query('UPDATE facebook_page_dm_pending_intents SET due_at=$1 WHERE id=$2', [
        nearDue,
        older.id,
      ]);
      const urgent = await schedulePageDmGroup(database, {
        workspaceId,
        accountId,
        conversationId: 'short-window',
        clientActionId: randomUUID(),
        texts: ['Reply'],
        expectedLatestInboundMessageId: 'short-inbound',
        windowDeadline: new Date(Date.now() + 90_000),
        actor: { type: 'api-key', id: actorId },
      });
      expect(urgent.dueAt.getTime()).toBeLessThan(nearDue.getTime());
      const rows = await pg.query<{ due_at: Date }>(
        'SELECT due_at FROM facebook_page_dm_pending_intents WHERE id=$1',
        [older.id],
      );
      expect(
        new Date(rows.rows[0]?.due_at ?? 0).getTime() - urgent.dueAt.getTime(),
      ).toBeGreaterThanOrEqual(60_000);
    } finally {
      await pg.close();
    }
  });

  it('leaves a claimed root and its dispatch cursor fixed when a more urgent root arrives', async () => {
    const { pg, database } = await setup();
    try {
      const schedule = (conversationId: string, hours: number) =>
        schedulePageDmGroup(database, {
          workspaceId,
          accountId,
          conversationId,
          clientActionId: randomUUID(),
          texts: ['Reply'],
          expectedLatestInboundMessageId: `inbound-${conversationId}`,
          windowDeadline: new Date(Date.now() + hours * 3600_000),
          actor: { type: 'api-key', id: actorId },
        });
      const first = await schedule('claimed', 4);
      const firstDue = first.dueAt;
      const claimed = await claimDuePageDms(database, {
        workerId: 'priority-worker',
        now: new Date(firstDue.getTime() + 1000),
        leaseMs: 30_000,
        limit: 1,
      });
      expect(claimed[0]?.id).toBe(first.id);
      const cursor = await pg.query<{ next_root_at: Date }>(
        'SELECT next_root_at FROM facebook_page_dm_dispatch_pacing WHERE account_id=$1',
        [accountId],
      );
      const nextRootAt = cursor.rows[0]?.next_root_at;
      if (!nextRootAt) throw new Error('Expected persisted Page pacing cursor');
      const urgent = await schedule('urgent-after-claim', 1);
      expect(urgent.dueAt.getTime()).toBeGreaterThanOrEqual(new Date(nextRootAt).getTime());
      const rows = await pg.query<{ status: string; due_at: Date }>(
        'SELECT status, due_at FROM facebook_page_dm_pending_intents WHERE id=$1',
        [first.id],
      );
      expect(rows.rows[0]?.status).toBe('claimed');
      expect(new Date(rows.rows[0]?.due_at ?? 0).getTime()).toBe(firstDue.getTime());
    } finally {
      await pg.close();
    }
  });

  it('does not move a pending root after a claimed pre-send retry', async () => {
    const { pg, database } = await setup();
    try {
      const schedule = (conversationId: string, minutes: number) =>
        schedulePageDmGroup(database, {
          workspaceId,
          accountId,
          conversationId,
          clientActionId: randomUUID(),
          texts: ['Reply'],
          expectedLatestInboundMessageId: `inbound-${conversationId}`,
          windowDeadline: new Date(Date.now() + minutes * 60_000),
          actor: { type: 'api-key', id: actorId },
        });
      const retry = await schedule('retry-root', 240);
      const [claimed] = await claimDuePageDms(database, {
        workerId: 'retry-worker',
        now: new Date(retry.dueAt.getTime() + 1000),
        leaseMs: 30_000,
        limit: 1,
      });
      if (!claimed?.leaseOwner) throw new Error('Expected claimed root with a lease');
      expect(
        await finishClaimedPageDm(database, {
          workspaceId,
          id: claimed.id,
          workerId: claimed.leaseOwner,
          state: 'pending',
        }),
      ).toBe(true);
      const before = await pg.query<{ due_at: Date; pre_send_attempts: number }>(
        'SELECT due_at, pre_send_attempts FROM facebook_page_dm_pending_intents WHERE id=$1',
        [retry.id],
      );
      const retryDue = new Date(before.rows[0]?.due_at ?? 0).getTime();
      expect(before.rows[0]?.pre_send_attempts).toBe(1);
      const urgent = await schedule('urgent-after-retry', 20).catch((error: unknown) => {
        expect(error).toBeInstanceOf(PendingDmConflictError);
        return null;
      });
      const after = await pg.query<{ status: string; due_at: Date; pre_send_attempts: number }>(
        'SELECT status, due_at, pre_send_attempts FROM facebook_page_dm_pending_intents WHERE id=$1',
        [retry.id],
      );
      expect(after.rows[0]?.status).toBe('pending');
      expect(after.rows[0]?.pre_send_attempts).toBe(1);
      expect(new Date(after.rows[0]?.due_at ?? 0).getTime()).toBe(retryDue);
      if (urgent)
        expect(Math.abs(urgent.dueAt.getTime() - retryDue)).toBeGreaterThanOrEqual(60_000);
    } finally {
      await pg.close();
    }
  });

  it('does not let a paced Page starve an overdue root on another Page', async () => {
    const { pg, database } = await setup();
    try {
      const secondAccountId = randomUUID();
      await pg.query(
        "INSERT INTO provider_accounts (id, workspace_id, destination_provider) VALUES ($1, $2, 'facebook_page')",
        [secondAccountId, workspaceId],
      );
      await schedulePageDmGroup(database, {
        workspaceId,
        accountId,
        conversationId: 't_1',
        clientActionId: randomUUID(),
        texts: ['One', 'Two'],
        expectedLatestInboundMessageId: 'inbound-1',
        windowDeadline: new Date(Date.now() + 3600_000),
        actor: { type: 'user', id: actorId },
      });
      await schedulePageDmGroup(database, {
        workspaceId,
        accountId,
        conversationId: 't_2',
        clientActionId: randomUUID(),
        texts: ['Three', 'Four'],
        expectedLatestInboundMessageId: 'inbound-2',
        windowDeadline: new Date(Date.now() + 3600_000),
        actor: { type: 'user', id: actorId },
      });
      const otherPage = await schedulePageDmGroup(database, {
        workspaceId,
        accountId: secondAccountId,
        conversationId: 't_3',
        clientActionId: randomUUID(),
        texts: ['Five', 'Six'],
        expectedLatestInboundMessageId: 'inbound-3',
        windowDeadline: new Date(Date.now() + 3600_000),
        actor: { type: 'user', id: actorId },
      });
      await pg.query(
        "UPDATE facebook_page_dm_pending_intents SET due_at = now() - interval '2 minutes' WHERE status = 'pending' AND account_id = $1",
        [accountId],
      );
      await pg.query(
        "UPDATE facebook_page_dm_pending_intents SET due_at = now() - interval '1 minute' WHERE status = 'pending' AND account_id = $1",
        [secondAccountId],
      );
      const now = new Date();
      const [claimedFirst] = await claimDuePageDms(database, {
        workerId: 'w',
        now,
        leaseMs: 30_000,
        limit: 1,
      });
      expect(claimedFirst?.accountId).toBe(accountId);
      const [claimedOther] = await claimDuePageDms(database, {
        workerId: 'w',
        now,
        leaseMs: 30_000,
        limit: 1,
      });
      expect(claimedOther?.id).toBe(otherPage.id);
    } finally {
      await pg.close();
    }
  });
});
