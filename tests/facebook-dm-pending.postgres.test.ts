import { readFile } from 'node:fs/promises';

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
  schedulePageDm,
  setPageDmDelayWindow,
} from '../src/modules/providers/facebook-dm-pending.repository.js';
import { setPageConversationNoGo } from '../src/modules/providers/facebook-dm-no-go.repository.js';
import { dispatchDuePageDms } from '../src/modules/providers/facebook-dm-pending.worker.js';

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
      target_id text NOT NULL, status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE facebook_page_dm_actions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL, client_action_id uuid NOT NULL, request_fingerprint text NOT NULL DEFAULT 'other-request',
      state text NOT NULL DEFAULT 'reserved');
    INSERT INTO workspaces VALUES ('${workspaceId}'), ('${otherWorkspaceId}');
    INSERT INTO provider_accounts VALUES ('${accountId}', '${workspaceId}', 'facebook_page');
  `);
  for (const migration of [
    '0095_facebook_page_dm_no_go.sql',
    '0097_facebook_page_dm_pending_intents.sql',
    '0098_engagement_proposal_planned_due_at.sql',
    '0099_page_dm_pre_send_attempts.sql',
  ]) {
    await pg.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  return { pg, database: drizzle(pg) as unknown as NodePgDatabase };
}

describe('Page DM pending intent', () => {
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
          workerId: 'worker-a',
          state: 'pending',
        }),
      ).rejects.toThrow('Cannot retry');
      expect(
        await finishClaimedPageDm(database, {
          workspaceId,
          id: first.id,
          workerId: 'worker-a',
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
              workerId: 'worker-a',
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
            workerId: 'worker-a',
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
});
