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
  await postgres.exec(`
    CREATE ROLE publish_relay_app NOLOGIN NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO publish_relay_app;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO publish_relay_app;
    SET ROLE publish_relay_app;
  `);
  database = drizzle(postgres) as unknown as NodePgDatabase;
});

afterEach(async () => postgres.close());

describe('Facebook DM action PostgreSQL ledger', () => {
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
