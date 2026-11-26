import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, it, expect, vi } from 'vitest';
import { schedulePageDmGroup } from '../src/modules/providers/facebook-dm-group.repository.js';
import { claimDuePageDms } from '../src/modules/providers/facebook-dm-pending.repository.js';
const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000003';
const actorId = '00000000-0000-4000-8000-000000000004';
const run = process.env.POSTGRES_GROUP_TEST_URL ? describe : describe.skip;
run('requested Page DM due time on real PostgreSQL', () => {
  it('preserves floors, replay, ordering, concurrent caps and deadline failure', async () => {
    const schema = 'dm_requested_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({ connectionString: process.env.POSTGRES_GROUP_TEST_URL });
    await admin.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      options: '-c search_path=' + schema + ',public',
      connectionString: process.env.POSTGRES_GROUP_TEST_URL,
      max: 4,
    });
    try {
      await pool.query(`
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
      state text NOT NULL DEFAULT 'reserved', updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE facebook_page_engagement_modules (
      workspace_id uuid NOT NULL, account_id uuid NOT NULL,
      dm_daily_group_limit_enabled boolean NOT NULL DEFAULT false,
      dm_daily_group_maximum integer NOT NULL DEFAULT 1 CHECK (dm_daily_group_maximum IN (1, 2)),
      dm_root_pacing_minimum_seconds integer NOT NULL DEFAULT 60,
      dm_root_pacing_maximum_seconds integer NOT NULL DEFAULT 120,
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
        await pool.query(
          await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'),
        );
      }
      const database = drizzle(pool);
      const base = {
        workspaceId,
        accountId,
        texts: ['Reply', 'Tail'],
        expectedLatestInboundMessageId: 'inbound',
        windowDeadline: new Date(Date.now() + 24 * 3600_000),
        actor: { type: 'user' as const, id: actorId },
      };
      const schedule = (conversationId: string, minutes: number) => ({
        ...base,
        conversationId,
        clientActionId: randomUUID(),
        dueAt: new Date(Date.now() + minutes * 60_000).toISOString(),
      });
      const request = schedule('later', 120);
      const later = await schedulePageDmGroup(database, request);
      expect(later.dueAt.getTime()).toBeGreaterThanOrEqual(Date.parse(request.dueAt));
      expect((await schedulePageDmGroup(database, request)).id).toBe(later.id);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(request.dueAt) + 1);
      try {
        expect((await schedulePageDmGroup(database, request)).id).toBe(later.id);
      } finally {
        clock.mockRestore();
      }

      await expect(
        schedulePageDmGroup(database, {
          ...request,
          dueAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ).rejects.toThrow();
      const urgent = await schedulePageDmGroup(database, {
        ...schedule('urgent', 1),
        windowDeadline: new Date(Date.now() + 10 * 60_000),
      });
      expect(urgent.dueAt.getTime()).toBeLessThan(later.dueAt.getTime());
      const existing = await pool.query<{ due_at: Date }>(
        'SELECT due_at FROM facebook_page_dm_pending_intents WHERE id=$1',
        [later.id],
      );
      expect(existing.rows[0]?.due_at.getTime()).toBeGreaterThanOrEqual(Date.parse(request.dueAt));
      expect(
        await claimDuePageDms(database, {
          workerId: 'early',
          now: new Date(),
          leaseMs: 30_000,
          limit: 10,
        }),
      ).toHaveLength(0);
      for (const dueAt of [
        'invalid',
        new Date(Date.now() - 60_000).toISOString(),
        new Date(Date.now() + 25 * 3600_000).toISOString(),
      ]) {
        await expect(
          schedulePageDmGroup(database, { ...schedule('invalid', 1), dueAt }),
        ).rejects.toThrow();
      }
      await pool.query(
        'INSERT INTO facebook_page_engagement_modules (workspace_id,account_id,dm_daily_group_limit_enabled) VALUES ($1,$2,true)',
        [workspaceId, accountId],
      );
      const concurrent = await Promise.allSettled(
        [1, 2].map((i) =>
          schedulePageDmGroup(database, {
            ...schedule('same', i),
            expectedLatestInboundMessageId: 'inbound-' + String(i),
          }),
        ),
      );
      expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejectedRows = await pool.query(
        "SELECT id FROM facebook_page_dm_pending_intents WHERE conversation_id = 'invalid'",
      );
      expect(rejectedRows.rows).toHaveLength(0);
      const mediumRequest = schedule('medium', 60);
      const medium = await schedulePageDmGroup(database, mediumRequest);
      expect(medium.dueAt.getTime()).toBeGreaterThanOrEqual(Date.parse(mediumRequest.dueAt));
      const defaultGroup = await schedulePageDmGroup(database, {
        ...base,
        conversationId: 'default',
        clientActionId: randomUUID(),
      });
      expect(defaultGroup.status).toBe('pending');
    } finally {
      await pool.end();
      await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
      await admin.end();
    }
  }, 30_000);
});
