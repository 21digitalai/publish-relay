import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const connectionString = process.env.PUBLISH_RELAY_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('Instagram Unified action ledger on isolated PostgreSQL', () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const databaseName = `relay4765_${suffix}`;
  const workspaceId = '00000000-0000-4000-8000-000000000101';
  const otherWorkspaceId = '00000000-0000-4000-8000-000000000102';
  const accountId = '00000000-0000-4000-8000-000000000201';
  const webRole = `relay4765_web_${suffix}`;
  const workerRole = `relay4765_worker_${suffix}`;
  const clients: Client[] = [];
  let admin: Client;
  let owner: Client;
  let databaseUrl: string;

  beforeAll(async () => {
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseUrl = connectionString!.replace(/\/postgres(?:\?|$)/, `/${databaseName}?`);

    await admin.query(
      `CREATE ROLE "${webRole}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await admin.query(
      `CREATE ROLE "${workerRole}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS`,
    );
    owner = new Client({ connectionString: databaseUrl });
    clients.push(owner);
    await owner.connect();
    await owner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await owner.query(
      "CREATE TYPE audit_actor_type AS ENUM ('user', 'api_key', 'delegated', 'system')",
    );
    await owner.query(`CREATE TABLE provider_accounts (
        workspace_id uuid NOT NULL,
        id uuid NOT NULL,
        PRIMARY KEY (workspace_id, id)
      )`);
    await owner.query(
      'INSERT INTO provider_accounts (workspace_id, id) VALUES ($1, $2), ($3, $2)',
      [workspaceId, accountId, otherWorkspaceId],
    );
    await owner.query(
      await readFile(
        new URL('../migrations/0131_instagram_unified_actions.sql', import.meta.url),
        'utf8',
      ),
    );
    await owner.query(`GRANT USAGE ON SCHEMA public TO "${webRole}", "${workerRole}"`);
    await owner.query(`GRANT SELECT, INSERT, UPDATE ON instagram_unified_actions TO "${webRole}"`);
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE ON instagram_unified_actions TO "${workerRole}"`,
    );
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end()));
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.query(`DROP ROLE IF EXISTS "${webRole}"`);
    await admin.query(`DROP ROLE IF EXISTS "${workerRole}"`);
    await admin.end();
  });

  async function webClient() {
    const client = new Client({ connectionString: databaseUrl });
    clients.push(client);
    await client.connect();
    await client.query(`SET ROLE "${webRole}"`);
    return client;
  }

  it('applies forced RLS, composite account ownership, and distinct runtime grants', async () => {
    const result = await owner.query<{
      forced: boolean;
      web_insert: boolean;
      worker_select: boolean;
    }>(
      `
      SELECT c.relforcerowsecurity AS forced,
        has_table_privilege($1, 'public.instagram_unified_actions', 'INSERT') AS web_insert,
        has_table_privilege($2, 'public.instagram_unified_actions', 'SELECT') AS worker_select
      FROM pg_class c WHERE c.oid = 'public.instagram_unified_actions'::regclass
    `,
      [webRole, workerRole],
    );
    expect(result.rows[0]).toEqual({ forced: true, web_insert: true, worker_select: true });
  });

  it('allows one concurrent reservation, isolates tenants, and preserves unknown without replay', async () => {
    const first = await webClient();
    const second = await webClient();
    const actionId = '00000000-0000-4000-8000-000000000301';
    const actorId = '00000000-0000-4000-8000-000000000401';
    const values = [workspaceId, accountId, actionId, actorId];
    await Promise.all([first.query('BEGIN'), second.query('BEGIN')]);
    await Promise.all([
      first.query('SELECT set_config($1, $2, false)', ['app.workspace_id', workspaceId]),
      second.query('SELECT set_config($1, $2, false)', ['app.workspace_id', workspaceId]),
    ]);
    const insert = (client: Client) =>
      client.query(
        `
      INSERT INTO instagram_unified_actions (
        workspace_id, account_id, client_action_id, kind, target_id, parent_id,
        text_body, request_fingerprint, actor_type, actor_id
      ) VALUES ($1, $2, $3, 'dm_reply', 'message-1', 'conversation-1', 'Hello', 'fingerprint-1', 'user', $4)
      ON CONFLICT (workspace_id, client_action_id) DO NOTHING
    `,
        values,
      );
    const firstResult = await insert(first);
    const secondInsert = insert(second);
    await first.query('COMMIT');
    const secondResult = await secondInsert;
    await second.query('COMMIT');
    const results = [firstResult, secondResult];
    expect(results.filter((result) => result.rowCount === 1)).toHaveLength(1);

    const ownerCount = await owner.query<{ count: string }>(
      'SELECT count(*) FROM instagram_unified_actions WHERE workspace_id = $1 AND client_action_id = $2',
      [workspaceId, actionId],
    );
    expect(ownerCount.rows[0]?.count).toBe('1');

    await owner.query(
      `UPDATE instagram_unified_actions SET state = 'unknown' WHERE workspace_id = $1 AND client_action_id = $2`,
      [workspaceId, actionId],
    );
    const isolated = await webClient();
    await isolated.query('SELECT set_config($1, $2, false)', [
      'app.workspace_id',
      otherWorkspaceId,
    ]);
    const hidden = await isolated.query(
      'SELECT count(*) FROM instagram_unified_actions WHERE client_action_id = $1',
      [actionId],
    );
    expect(hidden.rows[0]?.count).toBe('0');
    await isolated.query('ROLLBACK').catch(() => undefined);
    await isolated.end();

    const visible = await webClient();
    await visible.query('SELECT set_config($1, $2, false)', ['app.workspace_id', workspaceId]);
    const state = await visible.query<{ state: string }>(
      'SELECT state FROM instagram_unified_actions WHERE client_action_id = $1',
      [actionId],
    );
    expect(state.rows).toEqual([{ state: 'unknown' }]);
    await visible.end();
    await first.end();
    await second.end();
  });
});
