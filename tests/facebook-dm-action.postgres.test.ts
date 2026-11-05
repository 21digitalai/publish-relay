import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findFacebookDmAction,
  reserveFacebookDmAction,
  settleFacebookDmAction,
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
      PRIMARY KEY (workspace_id,id));
    CREATE TABLE audit_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL, actor_type audit_actor_type NOT NULL, actor_id uuid,
      action text NOT NULL, target_type text NOT NULL, target_id uuid,
      request_id text NOT NULL, ip_address text, user_agent text,
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO provider_accounts VALUES ('${accountId}','${workspaceId}');
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
    const labels = await postgres.query('SELECT receiver_label FROM facebook_page_dm_actions');
    expect(labels.rows).toEqual([{ receiver_label: 'Alexandra' }]);
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
