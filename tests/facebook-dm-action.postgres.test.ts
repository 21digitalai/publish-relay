import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findFacebookDmAction,
  reserveFacebookDmAction,
  settleFacebookDmAction,
  readPageDmFailureCircuit,
  clearPageDmFailureCircuit,
} from '../src/modules/providers/facebook-dm-action.repository.js';
import {
  CampaignFinalReopenError,
  reopenCampaignFinalConversation,
  setPageConversationNoGo,
} from '../src/modules/providers/facebook-dm-no-go.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const actorId = '00000000-0000-4000-8000-000000000003';
const actionId = '00000000-0000-4000-8000-000000000004';
const key = {
  workspaceId,
  accountId,
  clientActionId: actionId,
  conversationId: 't_123',
  text: 'Hello Alexandra',
  requestFingerprint: 'a'.repeat(64),
  actor: { type: 'api-key' as const, id: actorId },
};

let postgres: PGlite;
let database: NodePgDatabase;

beforeEach(async () => {
  postgres = new PGlite();
  await postgres.exec(`
    CREATE TYPE audit_actor_type AS ENUM ('user','api_key','delegated','system');
    CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL,
      destination_provider text NOT NULL,
      PRIMARY KEY (workspace_id,id));
    CREATE TABLE audit_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL, actor_type audit_actor_type NOT NULL, actor_id uuid,
      action text NOT NULL, target_type text NOT NULL, target_id uuid,
      request_id text NOT NULL, ip_address text, user_agent text,
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE facebook_page_dm_pending_intents (id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL, account_id uuid NOT NULL,
      conversation_id text NOT NULL, status text NOT NULL,
      client_action_id uuid NOT NULL DEFAULT gen_random_uuid(), group_id uuid,
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE engagement_proposals (id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
      account_id uuid NOT NULL, provider text NOT NULL, kind text NOT NULL,
      target_id text NOT NULL, status text NOT NULL, client_action_id uuid NOT NULL DEFAULT gen_random_uuid(),
      updated_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO provider_accounts VALUES ('${accountId}','${workspaceId}','facebook_page');
  `);
  await postgres.exec(
    readFileSync(
      new URL('../migrations/0091_facebook_page_dm_actions.sql', import.meta.url),
      'utf8',
    ),
  );
  await postgres.exec(
    readFileSync(
      new URL('../migrations/0096_facebook_page_dm_receiver_label.sql', import.meta.url),
      'utf8',
    ),
  );
  await postgres.exec(
    readFileSync(
      new URL('../migrations/0108_facebook_page_dm_action_text.sql', import.meta.url),
      'utf8',
    ),
  );
  await postgres.exec(
    readFileSync(new URL('../migrations/0095_facebook_page_dm_no_go.sql', import.meta.url), 'utf8'),
  );
  await postgres.exec(
    readFileSync(
      new URL('../migrations/0103_facebook_page_dm_memory.sql', import.meta.url),
      'utf8',
    ),
  );
  await postgres.exec(
    readFileSync(
      new URL('../migrations/0116_facebook_dm_failure_diagnostics.sql', import.meta.url),
      'utf8',
    ),
  );
  await postgres.exec(
    readFileSync(
      new URL('../migrations/0117_facebook_dm_failure_circuit.sql', import.meta.url),
      'utf8',
    ),
  );
  await postgres.exec(
    readFileSync(
      new URL('../migrations/0118_facebook_dm_final_exit_receipt.sql', import.meta.url),
      'utf8',
    ),
  );
  await postgres.exec(`
    CREATE ROLE publish_relay_app NOLOGIN NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO publish_relay_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO publish_relay_app;
    SET ROLE publish_relay_app;
  `);
  database = drizzle(postgres) as unknown as NodePgDatabase;
});

afterEach(async () => postgres.close());

describe('Facebook DM action PostgreSQL ledger', () => {
  it('reopens only a named confirmed final receipt and audits the owner action', async () => {
    const final = { ...key, finalExit: true };
    const reserved = await reserveFacebookDmAction(database, final);
    if (reserved.kind !== 'new') throw new Error('Expected final reservation');
    await settleFacebookDmAction(database, {
      ...final,
      reservationId: reserved.id,
      outcome: { state: 'confirmed', messageId: 'mid_final' },
    });
    await expect(
      setPageConversationNoGo(database, { ...key, blocked: false }),
    ).rejects.toBeInstanceOf(CampaignFinalReopenError);
    const ambiguous = { ...key, clientActionId: '00000000-0000-4000-8000-000000000088' };
    await reserveFacebookDmAction(database, ambiguous);
    const reopen = { ...key, actorId, requestId: 'owner-reopen-1' };
    await expect(reopenCampaignFinalConversation(database, reopen)).rejects.toThrow(
      'Unsettled Page message',
    );
    await postgres.query(`SELECT set_config('app.workspace_id', '${workspaceId}', false)`);
    expect((await postgres.query('SELECT terminal FROM facebook_page_dm_memory')).rows).toEqual([
      { terminal: true },
    ]);
    await postgres.query('DELETE FROM facebook_page_dm_actions WHERE client_action_id=$1', [
      ambiguous.clientActionId,
    ]);
    await postgres.query(
      `INSERT INTO facebook_page_dm_pending_intents
      (id, workspace_id, account_id, conversation_id, status)
      VALUES ('00000000-0000-4000-8000-000000000089', $1, $2, $3, 'unknown')`,
      [workspaceId, accountId, key.conversationId],
    );
    await expect(reopenCampaignFinalConversation(database, reopen)).rejects.toThrow(
      'Unsettled Page message',
    );
    await postgres.query('DELETE FROM facebook_page_dm_pending_intents');
    await reopenCampaignFinalConversation(database, reopen);
    expect((await postgres.query('SELECT * FROM facebook_page_dm_no_go')).rows).toHaveLength(0);
    expect(
      (await postgres.query('SELECT terminal, final_action_id FROM facebook_page_dm_memory')).rows,
    ).toEqual([{ terminal: false, final_action_id: actionId }]);
    expect(
      (
        await postgres.query(
          "SELECT action, request_id FROM audit_events WHERE action='facebook_page.dm_campaign_final_reopen'",
        )
      ).rows,
    ).toEqual([{ action: 'facebook_page.dm_campaign_final_reopen', request_id: 'owner-reopen-1' }]);
    await expect(reopenCampaignFinalConversation(database, reopen)).rejects.toThrow(
      'Confirmed campaign-final receipt required',
    );
    await setPageConversationNoGo(database, { ...key, blocked: true });
    await expect(reopenCampaignFinalConversation(database, reopen)).rejects.toThrow(
      'Confirmed campaign-final receipt required',
    );
    expect((await postgres.query('SELECT reason FROM facebook_page_dm_no_go')).rows).toEqual([
      { reason: 'manual' },
    ]);
  });
  it('records Page-local terminal and no-go only after confirmed final delivery', async () => {
    const final = { ...key, finalExit: true, requestFingerprint: 'f'.repeat(64) };
    const reserved = await reserveFacebookDmAction(database, final);
    if (reserved.kind !== 'new') throw new Error('Expected final reservation');
    await postgres.query(`SELECT set_config('app.workspace_id', '${workspaceId}', false)`);
    expect((await postgres.query('SELECT * FROM facebook_page_dm_no_go')).rows).toHaveLength(0);
    await settleFacebookDmAction(database, {
      ...final,
      reservationId: reserved.id,
      outcome: { state: 'confirmed', messageId: 'mid_final' },
    });
    const noGo = await postgres.query(
      'SELECT reason, final_action_id, final_message_id FROM facebook_page_dm_no_go',
    );
    expect(noGo.rows).toEqual([
      { reason: 'campaign_final', final_action_id: actionId, final_message_id: 'mid_final' },
    ]);
    const memory = await postgres.query(
      'SELECT terminal, final_action_id, final_message_id FROM facebook_page_dm_memory',
    );
    expect(memory.rows).toEqual([
      { terminal: true, final_action_id: actionId, final_message_id: 'mid_final' },
    ]);
    expect(await reserveFacebookDmAction(database, final)).toMatchObject({
      kind: 'existing',
      outcome: { state: 'confirmed' },
    });
  });

  it('never suppresses an unknown or failed final exit', async () => {
    for (const [index, outcome] of [
      { state: 'unknown' as const },
      { state: 'failed' as const, failureStatus: 400 },
    ].entries()) {
      const final = {
        ...key,
        clientActionId: `00000000-0000-4000-8000-${String(index + 50).padStart(12, '0')}`,
        finalExit: true,
      };
      const reserved = await reserveFacebookDmAction(database, final);
      if (reserved.kind !== 'new') throw new Error('Expected final reservation');
      await settleFacebookDmAction(database, { ...final, reservationId: reserved.id, outcome });
    }
    await postgres.query(`SELECT set_config('app.workspace_id', '${workspaceId}', false)`);
    expect((await postgres.query('SELECT * FROM facebook_page_dm_no_go')).rows).toHaveLength(0);
    expect((await postgres.query('SELECT * FROM facebook_page_dm_memory')).rows).toHaveLength(0);
  });
  it('halts one Page after three definite Graph failures until explicit owner clearance', async () => {
    for (let index = 0; index < 3; index += 1) {
      const action = {
        ...key,
        clientActionId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
      };
      const reserved = await reserveFacebookDmAction(database, action);
      if (reserved.kind !== 'new') throw new Error('Expected new action');
      await settleFacebookDmAction(database, {
        ...action,
        reservationId: reserved.id,
        outcome: { state: 'failed', failureStatus: 400 },
        failureEvidence: { code: 100, traceId: `trace_${String(index)}` },
      });
    }
    const halted = await readPageDmFailureCircuit(database, key);
    expect(halted.consecutiveFailures).toBe(3);
    expect(halted.haltedAt).toBeInstanceOf(Date);
    await expect(
      readPageDmFailureCircuit(database, {
        workspaceId,
        accountId: '00000000-0000-4000-8000-000000000099',
      }),
    ).rejects.toThrow('unavailable');
    await clearPageDmFailureCircuit(database, {
      workspaceId,
      accountId,
      actorId,
      requestId: 'clear-1',
    });
    expect(await readPageDmFailureCircuit(database, key)).toMatchObject({
      consecutiveFailures: 0,
      haltedAt: null,
    });
  });
  it('persists only bounded safe definite-failure diagnostics and keeps replay idempotent', async () => {
    const first = await reserveFacebookDmAction(database, key);
    if (first.kind !== 'new') throw new Error('Expected new action');
    await settleFacebookDmAction(database, {
      ...key,
      reservationId: first.id,
      outcome: { state: 'failed', failureStatus: 400 },
      failureEvidence: {
        code: 100,
        subcode: 2018001,
        traceId: 'A-safe_trace-1',
        isTransient: false,
      },
    });
    expect(await findFacebookDmAction(database, key)).toEqual({
      kind: 'existing',
      outcome: { state: 'failed', failureStatus: 400 },
    });
    expect(await reserveFacebookDmAction(database, key)).toEqual({
      kind: 'existing',
      outcome: { state: 'failed', failureStatus: 400 },
    });
    await postgres.query(`SELECT set_config('app.workspace_id', '${workspaceId}', false)`);
    const rows = await postgres.query(`SELECT failure_code, failure_subcode,
      failure_trace_id, failure_transient FROM facebook_page_dm_actions`);
    expect(rows.rows).toEqual([
      {
        failure_code: 100,
        failure_subcode: 2018001,
        failure_trace_id: 'A-safe_trace-1',
        failure_transient: false,
      },
    ]);
    expect(JSON.stringify(rows.rows)).not.toContain(key.text);
    const unsafeKey = { ...key, clientActionId: '00000000-0000-4000-8000-000000000005' };
    const unsafe = await reserveFacebookDmAction(database, unsafeKey);
    if (unsafe.kind !== 'new') throw new Error('Expected second action');
    await settleFacebookDmAction(database, {
      ...unsafeKey,
      reservationId: unsafe.id,
      outcome: { state: 'failed', failureStatus: 400 },
      failureEvidence: { code: 2_147_483_648, subcode: -1, traceId: 'secret/body with spaces' },
    });
    const redacted = await postgres.query(
      'SELECT failure_code, failure_subcode, failure_trace_id FROM facebook_page_dm_actions WHERE client_action_id=$1',
      [unsafeKey.clientActionId],
    );
    expect(redacted.rows).toEqual([
      { failure_code: null, failure_subcode: null, failure_trace_id: null },
    ]);
  });
  it('reserves once, replays confirmed evidence and rejects changed input', async () => {
    const first = await reserveFacebookDmAction(database, { ...key, receiverLabel: 'Alexandra' });
    expect(first.kind).toBe('new');
    if (first.kind !== 'new') throw new Error('Expected new action');
    await settleFacebookDmAction(database, {
      ...key,
      reservationId: first.id,
      outcome: { state: 'confirmed', messageId: 'mid_9' },
    });
    expect(await findFacebookDmAction(database, key)).toEqual({
      kind: 'existing',
      outcome: { state: 'confirmed', messageId: 'mid_9' },
    });
    await postgres.query(`SELECT set_config('app.workspace_id', '${workspaceId}', false)`);
    const labels = await postgres.query(
      'SELECT receiver_label, text_body FROM facebook_page_dm_actions',
    );
    expect(labels.rows).toEqual([{ receiver_label: 'Alexandra', text_body: 'Hello Alexandra' }]);
    expect(await reserveFacebookDmAction(database, { ...key, conversationId: 't_other' })).toEqual({
      kind: 'conflict',
    });
    const rows = await postgres.query('SELECT action, metadata FROM audit_events');
    expect(rows.rows).toEqual([
      {
        action: 'facebook_page.dm_send',
        metadata: { outcome: 'confirmed', conversationId: 't_123' },
      },
    ]);
  });

  it('replays an interrupted reservation as unknown and isolates workspaces', async () => {
    await reserveFacebookDmAction(database, key);
    expect(await findFacebookDmAction(database, key)).toEqual({
      kind: 'existing',
      outcome: { state: 'unknown' },
    });
    expect(
      await findFacebookDmAction(database, {
        ...key,
        workspaceId: '00000000-0000-4000-8000-000000000009',
      }),
    ).toBeNull();
  });
});
