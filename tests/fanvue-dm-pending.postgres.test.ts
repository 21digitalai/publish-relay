import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';

import {
  cancelPendingFanvueDm,
  claimDueFanvueDm,
  FanvueDmScheduleConflictError,
  finishClaimedFanvueDm,
  renewClaimedFanvueDm,
  replayScheduledFanvueDm,
  scheduleFanvueDm,
} from '../src/modules/providers/fanvue-dm-pending.repository.js';
import { dispatchDueFanvueDms } from '../src/modules/providers/fanvue-dm-pending.worker.js';

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
      await pg.exec(
        await readFile(
          new URL('../migrations/0112_fanvue_dm_pending_media_preview.sql', import.meta.url),
          'utf8',
        ),
      );
      await pg.exec(
        await readFile(
          new URL('../migrations/0113_fanvue_pending_target_label.sql', import.meta.url),
          'utf8',
        ),
      );
      const database = drizzle(pg) as unknown as NodePgDatabase;
      const scheduled = await scheduleFanvueDm(database, input);
      expect(scheduled).toMatchObject({ status: 'pending', text: 'Scheduled hello', mediaIds: [] });
      expect((await scheduleFanvueDm(database, input)).id).toBe(scheduled.id);
      expect((await replayScheduledFanvueDm(database, input))?.id).toBe(scheduled.id);
      await expect(
        replayScheduledFanvueDm(database, { ...input, text: 'Changed' }),
      ).rejects.toBeInstanceOf(FanvueDmScheduleConflictError);
      await expect(
        scheduleFanvueDm(database, { ...input, text: 'Changed' }),
      ).rejects.toBeInstanceOf(FanvueDmScheduleConflictError);
      await expect(
        scheduleFanvueDm(database, { ...input, workspaceId: otherWorkspaceId }),
      ).rejects.toBeInstanceOf(FanvueDmScheduleConflictError);
      expect(await cancelPendingFanvueDm(database, input)).toBe(true);
      expect(await cancelPendingFanvueDm(database, input)).toBe(false);
      expect((await scheduleFanvueDm(database, input)).status).toBe('cancelled');
      const priced = {
        ...input,
        clientActionId: '00000000-0000-4000-8000-000000000010',
        mediaIds: ['00000000-0000-4000-8000-000000000011'],
        mediaPreviewId: '00000000-0000-4000-8000-000000000011',
        price: 300,
      };
      expect(await scheduleFanvueDm(database, priced)).toMatchObject({
        mediaPreviewId: priced.mediaPreviewId,
        price: 300,
      });
      await expect(
        scheduleFanvueDm(database, { ...priced, mediaPreviewId: input.fanUuid }),
      ).rejects.toThrow();
      const count = await pg.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM fanvue_dm_pending_intents`,
      );
      expect(count.rows[0]?.count).toBe(2);
    } finally {
      await pg.close();
    }
  });

  it('paces across worker restarts and fences stale lease settlement', async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`
        CREATE TYPE audit_actor_type AS ENUM ('user', 'api_key', 'delegated');
        CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL,
          destination_provider text NOT NULL, PRIMARY KEY (workspace_id,id));
        CREATE TABLE fanvue_action_intents (id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
          client_action_id uuid NOT NULL);
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
          new URL('../migrations/0112_fanvue_dm_pending_media_preview.sql', import.meta.url),
          'utf8',
        ),
      );
      await pg.exec(
        await readFile(
          new URL('../migrations/0113_fanvue_pending_target_label.sql', import.meta.url),
          'utf8',
        ),
      );
      const database = drizzle(pg) as unknown as NodePgDatabase;
      const dueAt = new Date('2026-11-11T10:00:00Z');
      await scheduleFanvueDm(database, { ...input, dueAt });
      const second = { ...input, clientActionId: '00000000-0000-4000-8000-000000000007', dueAt };
      await scheduleFanvueDm(database, second);
      const firstClaim = await claimDueFanvueDm(database, {
        workerId: 'old',
        now: dueAt,
        leaseMs: 30_000,
      });
      expect(firstClaim?.status).toBe('claimed');
      expect(
        await claimDueFanvueDm(database, { workerId: 'new', now: dueAt, leaseMs: 30_000 }),
      ).toBeNull();
      expect(
        await renewClaimedFanvueDm(database, {
          workspaceId,
          id: firstClaim?.id ?? '',
          leaseOwner: 'wrong',
          leaseMs: 30_000,
        }),
      ).toBe(false);
      expect(
        await finishClaimedFanvueDm(database, {
          workspaceId,
          id: firstClaim?.id ?? '',
          leaseOwner: firstClaim?.leaseOwner ?? '',
          state: 'unknown',
        }),
      ).toBe(true);
      expect(
        await finishClaimedFanvueDm(database, {
          workspaceId,
          id: firstClaim?.id ?? '',
          leaseOwner: firstClaim?.leaseOwner ?? '',
          state: 'confirmed',
        }),
      ).toBe(false);
      const next = await pg.query<{ next_at: string }>(
        `SELECT next_at FROM fanvue_dm_dispatch_pacing WHERE workspace_id = '${workspaceId}'`,
      );
      const later = new Date(Date.parse(next.rows[0]?.next_at ?? '') + 1000);
      const secondClaim = await claimDueFanvueDm(database, {
        workerId: 'new',
        now: later,
        leaseMs: 30_000,
      });
      expect(secondClaim?.clientActionId).not.toBe(firstClaim?.clientActionId);
    } finally {
      await pg.close();
    }
  });

  it('rechecks authority before provider send and freezes a prior unknown action', async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`
        CREATE TYPE audit_actor_type AS ENUM ('user', 'api_key', 'delegated');
        CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'member');
        CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL,
          destination_provider text NOT NULL, PRIMARY KEY (workspace_id,id));
        CREATE TABLE memberships (workspace_id uuid NOT NULL, user_id uuid NOT NULL,
          role membership_role NOT NULL);
        CREATE TABLE api_keys (id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
          capabilities text[] NOT NULL, revoked_at timestamptz, expires_at timestamptz);
        CREATE TABLE registered_clients (id text PRIMARY KEY, allowed_scopes text[] NOT NULL);
        CREATE TABLE delegated_grants (id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
          client_id text NOT NULL, scopes text[] NOT NULL, revoked_at timestamptz);
        CREATE TABLE fanvue_action_intents (id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
          account_id uuid NOT NULL, client_action_id uuid NOT NULL, target_uuid uuid NOT NULL,
          action_kind text NOT NULL, state text NOT NULL, text_body text,
          media_count integer, price_cents integer);
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
          new URL('../migrations/0112_fanvue_dm_pending_media_preview.sql', import.meta.url),
          'utf8',
        ),
      );
      await pg.exec(
        await readFile(
          new URL('../migrations/0113_fanvue_pending_target_label.sql', import.meta.url),
          'utf8',
        ),
      );
      const database = drizzle(pg) as unknown as NodePgDatabase;
      const dueAt = new Date('2026-11-11T10:00:00Z');
      const actorId = '00000000-0000-4000-8000-000000000022';
      const action = { ...input, dueAt, actor: { type: 'user' as const, id: actorId } };
      await scheduleFanvueDm(database, action);
      const sendMessage = vi
        .fn()
        .mockResolvedValue({ state: 'confirmed', messageUuid: input.fanUuid });
      const runtime = { database, messages: { sendMessage }, workerId: 'worker', leaseMs: 30_000 };
      expect(await dispatchDueFanvueDms(runtime, dueAt)).toMatchObject({
        state: 'failed',
        settled: true,
      });
      expect(sendMessage).not.toHaveBeenCalled();
      const next = {
        ...action,
        clientActionId: '00000000-0000-4000-8000-000000000023',
        dueAt: new Date(dueAt.getTime() + 1000),
      };
      await scheduleFanvueDm(database, next);
      await pg.exec(`INSERT INTO memberships VALUES ('${workspaceId}','${actorId}','owner')`);
      await pg.exec(`INSERT INTO fanvue_action_intents VALUES (
        '00000000-0000-4000-8000-000000000024','${workspaceId}','${accountId}',
        '${next.clientActionId}','${next.fanUuid}','message','reserved','${next.text}',0,NULL)`);
      const cursor = await pg.query<{ next_at: string }>(
        `SELECT next_at FROM fanvue_dm_dispatch_pacing`,
      );
      expect(
        await dispatchDueFanvueDms(
          runtime,
          new Date(Date.parse(cursor.rows[0]?.next_at ?? '') + 1000),
        ),
      ).toMatchObject({ state: 'unknown', settled: true });
      expect(sendMessage).not.toHaveBeenCalled();
      const third = {
        ...action,
        clientActionId: '00000000-0000-4000-8000-000000000025',
        dueAt: new Date(dueAt.getTime() + 2000),
      };
      await scheduleFanvueDm(database, third);
      const nextCursor = await pg.query<{ next_at: string }>(
        `SELECT next_at FROM fanvue_dm_dispatch_pacing`,
      );
      expect(
        await dispatchDueFanvueDms(
          runtime,
          new Date(Date.parse(nextCursor.rows[0]?.next_at ?? '') + 1000),
        ),
      ).toMatchObject({ state: 'confirmed', settled: true });
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          clientActionId: third.clientActionId,
          fanUuid: third.fanUuid,
          text: third.text,
        }),
      );
    } finally {
      await pg.close();
    }
  });
});
