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
  ]) {
    await pg.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  return { pg, database: drizzle(pg) as unknown as NodePgDatabase };
}

describe('Page DM pending intent', () => {
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
