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
import { dispatchDueInstagramUnifiedIntent } from '../src/modules/providers/instagram-unified-pending.worker.js';
import {
  cancelInstagramUnifiedIntent,
  claimDueInstagramUnifiedIntent,
  finishClaimedInstagramUnifiedIntent,
  scheduleInstagramUnifiedIntent,
} from '../src/modules/providers/instagram-unified-pending.repository.js';
import {
  listInstagramUnifiedConversationHistory,
  setInstagramUnifiedConversationNoGo,
} from '../src/modules/providers/instagram-unified-no-go.repository.js';
import {
  reserveInstagramUnifiedAction,
  settleInstagramUnifiedAction,
} from '../src/modules/providers/instagram-unified-action.repository.js';

const connectionString = process.env.PUBLISH_RELAY_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('Instagram Unified action ledger on isolated PostgreSQL', () => {
  const suffix = `${String(process.pid)}_${String(Date.now())}`;
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
  let workerDatabase: ReturnType<typeof drizzle>;
  let workerPool: pg.Pool;

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
    if (!connectionString) throw new Error('PUBLISH_RELAY_POSTGRES_URL is required');
    databaseUrl = connectionString.replace(/\/postgres(?:\?|$)/, `/${databaseName}?`);
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
    const workerUrl = new URL(databaseUrl);
    workerUrl.username = workerLoginRole;
    workerUrl.password = 'relay4765-worker';
    workerUrl.searchParams.set('options', `-c role=${workerRole}`);
    workerPool = new pg.Pool({ connectionString: workerUrl.toString(), max: 2 });
    workerDatabase = drizzle(workerPool);
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end()));
    await webPool.end();
    await workerPool.end();
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
    const hidden = await isolated.query<{ count: string }>(
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
      sendConversationMessage: vi.fn().mockImplementation(() => {
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
      sendConversationMessage: vi.fn().mockImplementation(() => {
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

  it('proves pending-intent RLS, idempotency, cancellation, and one-winner due claims', async () => {
    const pendingRole = await owner.query<{
      forced: boolean;
      web_insert: boolean;
      worker_update: boolean;
    }>(
      `SELECT c.relforcerowsecurity AS forced,
        has_table_privilege($1, 'public.instagram_unified_pending_intents', 'INSERT') AS web_insert,
        has_table_privilege($2, 'public.instagram_unified_pending_intents', 'UPDATE') AS worker_update
       FROM pg_class c WHERE c.oid = 'public.instagram_unified_pending_intents'::regclass`,
      [webRole, workerRole],
    );
    expect(pendingRole.rows[0]).toEqual({ forced: true, web_insert: true, worker_update: true });

    const base = {
      workspaceId,
      accountId,
      clientActionId: '00000000-0000-4000-8000-000000000501',
      kind: 'dm_reply' as const,
      targetId: 'message-pending-1',
      parentId: 'conversation-pending-1',
      recipientId: 'recipient-1',
      text: 'Scheduled once',
      requestFingerprint: 'pending-fingerprint-1',
      targetFingerprint: 'target-fingerprint-1',
      actor: { type: 'user' as const, id: '00000000-0000-4000-8000-000000000401' },
      dueAt: new Date(Date.now() - 1_000),
    };
    const inserted = await scheduleInstagramUnifiedIntent(webDatabase as never, base);
    const replay = await scheduleInstagramUnifiedIntent(webDatabase as never, base);
    expect(replay.id).toBe(inserted.id);
    await expect(
      scheduleInstagramUnifiedIntent(webDatabase as never, {
        ...base,
        text: 'Conflicting payload',
      }),
    ).rejects.toThrow('conflicts with an existing action');

    const [first, second] = await Promise.all([
      claimDueInstagramUnifiedIntent(workerDatabase as never, {
        workerId: 'worker-a',
        now: new Date(),
        leaseMs: 30_000,
      }),
      claimDueInstagramUnifiedIntent(workerDatabase as never, {
        workerId: 'worker-b',
        now: new Date(),
        leaseMs: 30_000,
      }),
    ]);
    const claimed = [first, second].filter((row) => row?.id === inserted.id);
    expect(claimed).toHaveLength(1);
    const claim = claimed[0];
    expect(claim?.status).toBe('claimed');
    expect(
      await cancelInstagramUnifiedIntent(webDatabase as never, {
        workspaceId,
        accountId,
        id: inserted.id,
      }),
    ).toBe(false);
    expect(
      await finishClaimedInstagramUnifiedIntent(workerDatabase as never, {
        workspaceId,
        id: inserted.id,
        leaseOwner: claim?.leaseOwner ?? '',
        state: 'unknown',
      }),
    ).toBe(true);
    expect(
      await claimDueInstagramUnifiedIntent(workerDatabase as never, {
        workerId: 'worker-c',
        now: new Date(),
        leaseMs: 30_000,
      }),
    ).toBeNull();

    const cancellable = await scheduleInstagramUnifiedIntent(webDatabase as never, {
      ...base,
      clientActionId: '00000000-0000-4000-8000-000000000502',
      requestFingerprint: 'pending-fingerprint-2',
      dueAt: new Date(Date.now() + 60_000),
    });
    expect(
      await cancelInstagramUnifiedIntent(webDatabase as never, {
        workspaceId,
        accountId,
        id: cancellable.id,
      }),
    ).toBe(true);
    expect(
      await claimDueInstagramUnifiedIntent(workerDatabase as never, {
        workerId: 'worker-d',
        now: new Date(Date.now() + 120_000),
        leaseMs: 30_000,
      }),
    ).toBeNull();

    const isolated = await webClient();
    await isolated.query('SELECT set_config($1, $2, false)', [
      'app.workspace_id',
      otherWorkspaceId,
    ]);
    const hidden = await isolated.query<{ count: string }>(
      'SELECT count(*) FROM instagram_unified_pending_intents WHERE id = $1',
      [inserted.id],
    );
    expect(hidden.rows[0]?.count).toBe('0');
    await isolated.end();
  });

  it('marks stale inbound and revoked-grant dispatches terminal without sending', async () => {
    mocks.loadToken.mockResolvedValue({
      accessToken: 'synthetic-token',
      remoteAccountId: 'unified-test-remote',
    });
    const provider = {
      verifyMessagingPermission: vi.fn().mockResolvedValue('granted'),
      listMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: 'message-stale',
            senderId: 'recipient-stale',
            createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
          },
        ],
      }),
      sendConversationMessage: vi.fn(),
    };
    const base = {
      workspaceId,
      accountId,
      kind: 'dm_reply' as const,
      targetId: 'message-stale',
      parentId: 'conversation-stale',
      recipientId: 'recipient-stale',
      text: 'Must not send',
      requestFingerprint: 'dispatch-terminal-fingerprint',
      targetFingerprint: '0'.repeat(64),
      actor: { type: 'user' as const, id: '00000000-0000-4000-8000-000000000401' },
      dueAt: new Date(Date.now() - 1_000),
    };
    const stale = await scheduleInstagramUnifiedIntent(webDatabase as never, {
      ...base,
      clientActionId: '00000000-0000-4000-8000-000000000503',
    });
    const runtime = {
      database: workerDatabase as never,
      keys: {} as never,
      client: provider as never,
      workerId: 'terminal-worker',
      leaseMs: 30_000,
    };
    await expect(dispatchDueInstagramUnifiedIntent(runtime)).resolves.toEqual({
      confirmed: 0,
      failed: 0,
      unknown: 0,
      expired: 1,
    });
    const staleState = await owner.query<{ status: string }>(
      'SELECT status FROM instagram_unified_pending_intents WHERE id = $1',
      [stale.id],
    );
    expect(staleState.rows).toEqual([{ status: 'expired' }]);
    expect(provider.sendConversationMessage).not.toHaveBeenCalled();

    const revoked = await scheduleInstagramUnifiedIntent(webDatabase as never, {
      ...base,
      clientActionId: '00000000-0000-4000-8000-000000000504',
      targetId: 'message-revoked',
      parentId: 'conversation-revoked',
      recipientId: 'recipient-revoked',
      targetFingerprint: '1'.repeat(64),
    });
    provider.verifyMessagingPermission.mockResolvedValueOnce('missing');
    provider.listMessages.mockResolvedValueOnce({
      messages: [{ id: 'message-revoked', senderId: 'recipient-revoked', createdAt: new Date().toISOString() }],
    });
    await expect(dispatchDueInstagramUnifiedIntent(runtime)).resolves.toEqual({
      confirmed: 0,
      failed: 0,
      unknown: 0,
      expired: 1,
    });
    const revokedState = await owner.query<{ status: string }>(
      'SELECT status FROM instagram_unified_pending_intents WHERE id = $1',
      [revoked.id],
    );
    expect(revokedState.rows).toEqual([{ status: 'expired' }]);
    expect(provider.sendConversationMessage).not.toHaveBeenCalled();
  });

  it('atomically cancels pending DM work, preserves terminal outcomes, and projects DM-only history', async () => {
    const conversationId = 'conversation-stop-history';
    const dm = await scheduleInstagramUnifiedIntent(webDatabase as never, {
      workspaceId,
      accountId,
      clientActionId: '00000000-0000-4000-8000-000000000505',
      kind: 'dm_reply',
      targetId: 'message-stop-history',
      parentId: conversationId,
      recipientId: 'recipient-stop-history',
      text: 'Cancel me',
      requestFingerprint: 'stop-history-dm',
      targetFingerprint: '2'.repeat(64),
      actor: { type: 'user', id: '00000000-0000-0000-0000-000000000401' },
      dueAt: new Date(Date.now() + 60_000),
    });
    const comment = await scheduleInstagramUnifiedIntent(webDatabase as never, {
      workspaceId,
      accountId,
      clientActionId: '00000000-0000-4000-8000-000000000506',
      kind: 'comment_reply',
      targetId: 'comment-stop-history',
      parentId: conversationId,
      text: 'Keep comment work separate',
      requestFingerprint: 'stop-history-comment',
      targetFingerprint: '3'.repeat(64),
      actor: { type: 'user', id: '00000000-0000-0000-0000-000000000401' },
      dueAt: new Date(Date.now() + 60_000),
    });
    const action = await reserveInstagramUnifiedAction(webDatabase as never, {
      workspaceId,
      accountId,
      clientActionId: '00000000-0000-0000-0000-000000000507',
      kind: 'dm_reply',
      targetId: 'message-terminal-history',
      parentId: conversationId,
      recipientId: 'recipient-stop-history',
      text: 'Already unknown',
      requestFingerprint: 'stop-history-terminal',
      actor: { type: 'user', id: '00000000-0000-0000-0000-000000000401' },
    });
    if (action.kind !== 'new') throw new Error('expected a new action reservation');
    await settleInstagramUnifiedAction(webDatabase as never, {
      workspaceId,
      accountId,
      clientActionId: '00000000-0000-0000-0000-000000000507',
      kind: 'dm_reply',
      targetId: 'message-terminal-history',
      parentId: conversationId,
      recipientId: 'recipient-stop-history',
      text: 'Already unknown',
      requestFingerprint: 'stop-history-terminal',
      actor: { type: 'user', id: '00000000-0000-0000-0000-000000000401' },
      reservationId: action.id,
      outcome: { state: 'unknown' },
    });

    await expect(
      setInstagramUnifiedConversationNoGo(webDatabase as never, {
        workspaceId,
        accountId,
        conversationId,
        blocked: true,
      }),
    ).resolves.toEqual({ cancelled: 1 });
    const statuses = await owner.query<{ id: string; status: string }>(
      'SELECT id, status FROM instagram_unified_pending_intents WHERE id IN ($1, $2) ORDER BY id',
      [dm.id, comment.id],
    );
    expect(Object.fromEntries(statuses.rows.map((row) => [row.id, row.status]))).toEqual({
      [comment.id]: 'pending',
      [dm.id]: 'cancelled',
    });

    const history = await listInstagramUnifiedConversationHistory(webDatabase as never, {
      workspaceId,
      accountId,
      conversationId,
      limit: 20,
    });
    expect(history.map((item) => ({ kind: item.kind, status: item.status }))).toEqual([
      { kind: 'dm_reply', status: 'unknown' },
      { kind: 'dm_reply', status: 'cancelled' },
    ]);
    expect(history.every((item) => item.kind === 'dm_reply')).toBe(true);

    await expect(
      setInstagramUnifiedConversationNoGo(webDatabase as never, {
        workspaceId,
        accountId,
        conversationId,
        blocked: false,
      }),
    ).resolves.toBeUndefined();
    const afterResume = await claimDueInstagramUnifiedIntent(workerDatabase as never, {
      workerId: 'stop-history-worker',
      now: new Date(Date.now() + 120_000),
      leaseMs: 30_000,
    });
    expect(afterResume?.id).toBe(comment.id);
    await finishClaimedInstagramUnifiedIntent(workerDatabase as never, {
      workspaceId,
      id: comment.id,
      leaseOwner: afterResume?.leaseOwner ?? '',
      state: 'expired',
    });
    const cancelledClaim = await claimDueInstagramUnifiedIntent(workerDatabase as never, {
      workerId: 'stop-history-worker-2',
      now: new Date(Date.now() + 120_000),
      leaseMs: 30_000,
    });
    expect(cancelledClaim?.id).not.toBe(dm.id);
  });

  it('holds the account lock across a stop-winning concurrent send and never calls the provider', async () => {
    const conversationId = 'conversation-stop-race';
    const client = {
      verifyMessagingPermission: vi.fn().mockResolvedValue('granted'),
      listMessages: vi.fn().mockResolvedValue({
        messages: [{ id: 'message-stop-race', senderId: 'recipient-stop-race', createdAt: new Date().toISOString() }],
      }),
      sendConversationMessage: vi.fn().mockResolvedValue('must-not-send'),
    };
    mocks.loadToken.mockResolvedValue({
      accessToken: 'synthetic-token',
      remoteAccountId: 'unified-test-remote',
    });
    const service = createInstagramUnifiedSendService({
      database: webDatabase as never,
      keys: {} as never,
      client: client as never,
    });
    const stop = setInstagramUnifiedConversationNoGo(webDatabase as never, {
      workspaceId,
      accountId,
      conversationId,
      blocked: true,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const send = service.send({
      workspaceId,
      accountId,
      clientActionId: '00000000-0000-4000-8000-000000000508',
      kind: 'dm_reply',
      targetId: 'message-stop-race',
      parentId: conversationId,
      recipientId: 'recipient-stop-race',
      text: 'Must not send',
      actor: { type: 'user', id: '00000000-0000-4000-8000-000000000401' },
    });
    await stop;
    await expect(send).rejects.toThrow('conversation is stopped');
    expect(client.sendConversationMessage).not.toHaveBeenCalled();
  });
});
