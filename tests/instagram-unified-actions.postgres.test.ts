import { readFile } from 'node:fs/promises';
import pg, { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadToken: vi.fn(),
}));

vi.mock('../src/modules/providers/instagram-unified-read.service.js', () => ({
  loadInstagramUnifiedToken: mocks.loadToken,
}));

import { createInstagramUnifiedSendService } from '../src/modules/providers/instagram-unified-send.service.js';

const connectionString = process.env.PUBLISH_RELAY_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('Instagram Unified action ledger on isolated PostgreSQL', () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const databaseName = `relay4765_${suffix}`;
  const workspaceId = '00000000-0000-4000-8000-000000000101';
  const otherWorkspaceId = '00000000-0000-4000-8000-000000000102';
  const accountId = '00000000-0000-4000-8000-000000000201';
  const webRole = 'publish_relay_web';
  const workerRole = 'publish_relay_worker';
  const webLoginRole = 'publish_relay_web_login';
  const workerLoginRole = 'publish_relay_worker_login';
  const createdRoles: string[] = [];
  const clients: Client[] = [];
  let admin: Client;
  let owner: Client;
  let databaseUrl: string;
  let webDatabase: ReturnType<typeof drizzle>;
  let webPool: pg.Pool;

  beforeAll(async () => {
    admin = new Client({ connectionString });
    await admin.connect();
    for (const [role, attributes] of [
      [webLoginRole, 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'],
      [workerLoginRole, 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'],
    ] as const) {
      const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (exists.rowCount === 0) {
        await admin.query(`CREATE ROLE "${role}" ${attributes}`);
        createdRoles.push(role);
      }
    }
    await admin.query(`ALTER ROLE "${webLoginRole}" PASSWORD 'relay4765-web'`);
    await admin.query(`ALTER ROLE "${workerLoginRole}" PASSWORD 'relay4765-worker'`);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseUrl = connectionString!.replace(/\/postgres(?:\?|$)/, `/${databaseName}?`);
    const provision = await readFile(
      new URL('../deploy/provision-database-roles.sql', import.meta.url),
      'utf8',
    );
    await admin.query(provision.replace(/^\\set[^\n]*\n/m, ''));
    for (const role of [webRole, workerRole]) {
      const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (exists.rowCount === 0) createdRoles.push(role);
    }
    owner = new Client({ connectionString: databaseUrl });
    clients.push(owner);
    await owner.connect();
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await migrate(drizzle(pool), {
      migrationsFolder: new URL('../migrations', import.meta.url).pathname,
    });
    await migrate(drizzle(pool), {
      migrationsFolder: new URL('../migrations', import.meta.url).pathname,
    });
    await pool.end();
    const bootstrap = await readFile(
      new URL('../deploy/bootstrap-database-authorities.sql', import.meta.url),
      'utf8',
    );
    await owner.query(bootstrap.replace(/^\\set[^\n]*\n/m, ''));
    await owner.query('GRANT publish_relay_web TO CURRENT_USER');
    await owner.query(
      `INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Unified test A', 'unified-test-a'), ($2, 'Unified test B', 'unified-test-b')`,
      [workspaceId, otherWorkspaceId],
    );
    const credentialId = '00000000-0000-4000-8000-000000000211';
    const connectionId = '00000000-0000-4000-8000-000000000221';
    await owner.query(
      `INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
       VALUES ($1, $2, 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06')`,
      [credentialId, workspaceId],
    );
    await owner.query(
      `INSERT INTO provider_connections (id, workspace_id, provider, credential_id, external_subject_id)
       VALUES ($1, $2, 'instagram_unified_login', $3, 'unified-test-subject')`,
      [connectionId, workspaceId, credentialId],
    );
    await owner.query(
      `INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, destination_provider, remote_account_id, display_name)
       VALUES ($1, $2, $3, 'unified-test-account', 'instagram', 'unified-test-remote', 'Unified test')`,
      [accountId, workspaceId, connectionId],
    );
    const webUrl = new URL(databaseUrl);
    webUrl.username = webLoginRole;
    webUrl.password = 'relay4765-web';
    webPool = new pg.Pool({ connectionString: webUrl.toString(), max: 2 });
    webDatabase = drizzle(webPool);
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end()));
    await webPool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
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

  it('allows one concurrent reservation and rejects a cross-tenant composite account row', async () => {
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

    const foreignInsert = await webClient();
    await foreignInsert.query('BEGIN');
    await foreignInsert.query('SELECT set_config($1, $2, true)', [
      'app.workspace_id',
      otherWorkspaceId,
    ]);
    await expect(
      foreignInsert.query(
        `INSERT INTO instagram_unified_actions (
        workspace_id, account_id, client_action_id, kind, target_id, parent_id,
        text_body, request_fingerprint, actor_type, actor_id
      ) VALUES ($1, $2, $3, 'dm_reply', 'message-1', 'conversation-1', 'Hello', 'fingerprint-1', 'user', $4)`,
        [otherWorkspaceId, accountId, '00000000-0000-4000-8000-000000000302', actorId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await foreignInsert.query('ROLLBACK');
    await foreignInsert.end();
    await first.end();
    await second.end();
  });

  it('records provider transport loss through the real service and never replays it', async () => {
    mocks.loadToken.mockResolvedValue({
      accessToken: 'synthetic-token',
      remoteAccountId: 'unified-test-remote',
    });
    const calls = { count: 0 };
    const client = {
      verifyMessagingPermission: vi.fn().mockResolvedValue('granted'),
      listMessages: vi.fn().mockResolvedValue({
        messages: [
          { id: 'message-transport', senderId: 'recipient-1', createdAt: new Date().toISOString() },
        ],
      }),
      sendConversationMessage: vi.fn().mockImplementation(async () => {
        calls.count += 1;
        throw new Error('transport lost');
      }),
    };
    const input = {
      workspaceId,
      accountId,
      clientActionId: '00000000-0000-4000-8000-000000000303',
      kind: 'dm_reply' as const,
      targetId: 'message-transport',
      parentId: 'conversation-transport',
      recipientId: 'recipient-1',
      text: 'Transport test',
      actor: { type: 'user' as const, id: '00000000-0000-4000-8000-000000000401' },
    };
    const service = createInstagramUnifiedSendService({
      database: webDatabase as never,
      keys: {} as never,
      client: client as never,
    });

    await expect(service.send(input)).resolves.toEqual({ state: 'unknown' });
    await expect(service.send(input)).resolves.toEqual({ state: 'unknown' });
    expect(calls.count).toBe(1);
    const state = await owner.query<{ state: string }>(
      'SELECT state FROM instagram_unified_actions WHERE workspace_id = $1 AND client_action_id = $2',
      [workspaceId, input.clientActionId],
    );
    expect(state.rows).toEqual([{ state: 'unknown' }]);
  });

  it('leaves a lost settlement reserved and replays it as unknown without another provider call', async () => {
    mocks.loadToken.mockResolvedValue({
      accessToken: 'synthetic-token',
      remoteAccountId: 'unified-test-remote',
    });
    const calls = { count: 0 };
    const client = {
      verifyMessagingPermission: vi.fn().mockResolvedValue('granted'),
      listMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: 'message-settlement',
            senderId: 'recipient-1',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
      sendConversationMessage: vi.fn().mockImplementation(async () => {
        calls.count += 1;
        return 'provider-receipt-after-lost-settlement';
      }),
    };
    const input = {
      workspaceId,
      accountId,
      clientActionId: '00000000-0000-4000-8000-000000000304',
      kind: 'dm_reply' as const,
      targetId: 'message-settlement',
      parentId: 'conversation-settlement',
      recipientId: 'recipient-1',
      text: 'Settlement test',
      actor: { type: 'user' as const, id: '00000000-0000-4000-8000-000000000401' },
    };
    const service = createInstagramUnifiedSendService({
      database: webDatabase as never,
      keys: {} as never,
      client: client as never,
    });

    await owner.query('REVOKE UPDATE ON instagram_unified_actions FROM publish_relay_web');
    await expect(service.send(input)).rejects.toBeTruthy();
    const reserved = await owner.query<{ state: string }>(
      'SELECT state FROM instagram_unified_actions WHERE workspace_id = $1 AND client_action_id = $2',
      [workspaceId, input.clientActionId],
    );
    expect(reserved.rows).toEqual([{ state: 'reserved' }]);
    await owner.query('GRANT UPDATE ON instagram_unified_actions TO publish_relay_web');

    await expect(service.send(input)).resolves.toEqual({ state: 'unknown' });
    expect(calls.count).toBe(1);
  });
});
