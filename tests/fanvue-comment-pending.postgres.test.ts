import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';

import {
  cancelPendingFanvueComment,
  claimDueFanvueComment,
  FanvueCommentScheduleConflictError,
  finishClaimedFanvueComment,
  replayScheduledFanvueComment,
  scheduleFanvueComment,
} from '../src/modules/providers/fanvue-comment-pending.repository.js';
import { dispatchDueFanvueComments } from '../src/modules/providers/fanvue-comment-pending.worker.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000003';
const postUuid = '00000000-0000-4000-8000-000000000004';
const input = {
  workspaceId,
  accountId,
  postUuid,
  clientActionId: '00000000-0000-4000-8000-000000000005',
  actor: { type: 'api-key' as const, id: '00000000-0000-4000-8000-000000000006' },
  text: 'Scheduled top-level comment',
  dueAt: new Date('2026-11-11T10:00:00Z'),
};

async function fixture() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TYPE audit_actor_type AS ENUM ('user', 'api_key', 'delegated');
    CREATE TABLE engagement_proposals (workspace_id uuid NOT NULL, client_action_id uuid NOT NULL,
      provider text NOT NULL, kind text NOT NULL, status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL, destination_provider text NOT NULL,
      PRIMARY KEY (workspace_id,id));
    CREATE TABLE fanvue_action_intents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
      account_id uuid, client_action_id uuid NOT NULL, action_kind text, target_uuid uuid, state text,
      text_body text);
    CREATE TABLE memberships (workspace_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL);
    INSERT INTO provider_accounts VALUES ('${accountId}','${workspaceId}','fanvue');
  `);
  await pg.exec(
    await readFile(
      new URL('../migrations/0111_fanvue_dm_pending_intents.sql', import.meta.url),
      'utf8',
    ),
  );
  await pg.exec(
    await readFile(
      new URL('../migrations/0115_fanvue_comment_pending_intents.sql', import.meta.url),
      'utf8',
    ),
  );
  return { pg, database: drizzle(pg) as unknown as NodePgDatabase };
}

describe('Fanvue supported-comment pending intents', () => {
  it('keeps immutable exact-action replay, tenant isolation and pending-only cancellation', async () => {
    const { pg, database } = await fixture();
    try {
      const first = await scheduleFanvueComment(database, input);
      expect(first).toMatchObject({ status: 'pending', text: input.text, postUuid });
      expect((await replayScheduledFanvueComment(database, input))?.id).toBe(first.id);
      expect((await scheduleFanvueComment(database, input)).id).toBe(first.id);
      await expect(
        scheduleFanvueComment(database, { ...input, text: 'Changed' }),
      ).rejects.toBeInstanceOf(FanvueCommentScheduleConflictError);
      await expect(
        scheduleFanvueComment(database, {
          ...input,
          workspaceId: '00000000-0000-4000-8000-000000000002',
        }),
      ).rejects.toBeInstanceOf(FanvueCommentScheduleConflictError);
      expect(await cancelPendingFanvueComment(database, input)).toBe(true);
      expect(
        await cancelPendingFanvueComment(database, {
          ...input,
          clientActionId: first.clientActionId,
        }),
      ).toBe(false);
      expect((await scheduleFanvueComment(database, input)).status).toBe('cancelled');
    } finally {
      await pg.close();
    }
  });

  it('paces claims, fences stale settlement and does not retry after action reservation', async () => {
    const { pg, database } = await fixture();
    try {
      await scheduleFanvueComment(database, input);
      await scheduleFanvueComment(database, {
        ...input,
        clientActionId: '00000000-0000-4000-8000-000000000007',
      });
      const first = await claimDueFanvueComment(database, {
        workerId: 'first',
        now: input.dueAt,
        leaseMs: 30_000,
      });
      expect(first?.status).toBe('claimed');
      expect(
        await claimDueFanvueComment(database, {
          workerId: 'second',
          now: input.dueAt,
          leaseMs: 30_000,
        }),
      ).toBeNull();
      expect(
        await cancelPendingFanvueComment(database, {
          ...input,
          clientActionId: first?.clientActionId ?? '',
        }),
      ).toBe(false);
      expect(
        await finishClaimedFanvueComment(database, {
          workspaceId,
          id: first?.id ?? '',
          leaseOwner: 'wrong',
          state: 'confirmed',
        }),
      ).toBe(false);
      await pg.exec(`INSERT INTO fanvue_action_intents (workspace_id,client_action_id)
        VALUES ('${workspaceId}','${first?.clientActionId ?? ''}')`);
      await expect(
        finishClaimedFanvueComment(database, {
          workspaceId,
          id: first?.id ?? '',
          leaseOwner: first?.leaseOwner ?? '',
          state: 'pending',
        }),
      ).rejects.toThrow('Cannot retry');
      expect(
        await finishClaimedFanvueComment(database, {
          workspaceId,
          id: first?.id ?? '',
          leaseOwner: first?.leaseOwner ?? '',
          state: 'unknown',
        }),
      ).toBe(true);
      const next = await pg.query<{ next_at: string }>(
        `SELECT next_at FROM fanvue_dm_dispatch_pacing WHERE workspace_id='${workspaceId}'`,
      );
      const later = new Date(Date.parse(next.rows[0]?.next_at ?? '') + 1000);
      const second = await claimDueFanvueComment(database, {
        workerId: 'second',
        now: later,
        leaseMs: 30_000,
      });
      expect(second?.clientActionId).not.toBe(first?.clientActionId);
    } finally {
      await pg.close();
    }
  });

  it('rechecks current human authority and freezes an existing ambiguous action without another send', async () => {
    const { pg, database } = await fixture();
    try {
      const owner = '00000000-0000-4000-8000-000000000010';
      const dueAt = new Date('2026-11-11T10:00:00Z');
      const command = { ...input, actor: { type: 'user' as const, id: owner }, dueAt };
      await scheduleFanvueComment(database, command);
      const send = vi.fn().mockResolvedValue({ state: 'confirmed', commentUuid: postUuid });
      const runtime = { database, comments: { send }, workerId: 'test', leaseMs: 30_000 };
      expect((await dispatchDueFanvueComments(runtime, dueAt))?.state).toBe('failed');
      expect(send).not.toHaveBeenCalled();

      const second = { ...command, clientActionId: '00000000-0000-4000-8000-000000000011' };
      await scheduleFanvueComment(database, second);
      await pg.exec(`INSERT INTO memberships VALUES ('${workspaceId}','${owner}','owner')`);
      await pg.exec(`INSERT INTO fanvue_action_intents
        (workspace_id,account_id,client_action_id,action_kind,target_uuid,state,text_body)
        VALUES ('${workspaceId}','${accountId}','${second.clientActionId}','comment','${postUuid}','reserved','${second.text}')`);
      const next = await pg.query<{ next_at: string }>(
        `SELECT next_at FROM fanvue_dm_dispatch_pacing WHERE workspace_id='${workspaceId}'`,
      );
      const later = new Date(Date.parse(next.rows[0]?.next_at ?? '') + 1000);
      expect((await dispatchDueFanvueComments(runtime, later))?.state).toBe('unknown');
      expect(send).not.toHaveBeenCalled();
    } finally {
      await pg.close();
    }
  });
});
