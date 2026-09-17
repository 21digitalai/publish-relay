import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  createCredential,
  getActiveCredential,
  revokeCredential,
  rotateCredential,
} from '../src/modules/credentials/credential.repository.js';
import type {
  EncryptedCredential,
  MasterKeyProvider,
} from '../src/modules/credentials/envelope.js';
import { decryptCredential } from '../src/modules/credentials/envelope.js';
import { FakeProviderConnectionAdapter } from '../src/modules/credentials/provider-adapter.js';
import { connectProvider } from '../src/modules/credentials/provider-connection.service.js';
import {
  disconnectProviderAccount,
  listProviderAccounts,
  updateYouTubeAccountDefaults,
} from '../src/modules/credentials/provider-account.service.js';
import {
  cleanupExpiredOauthTransactions,
  consumeOauthCallback,
  hashOauthState,
  issueOauthTransaction,
} from '../src/modules/credentials/oauth.service.js';
import { XHttpClient } from '../src/modules/providers/x-http-client.js';
import {
  beginXOauthConnection,
  completeXOauthConnection,
} from '../src/modules/providers/x-oauth.service.js';
import type { ActionPolicy } from '../src/modules/policy/action-policy.js';
import { completeYouTubeOauthConnection } from '../src/modules/providers/youtube-oauth.service.js';
import { registerDestinationRoutes } from '../src/modules/credentials/destination.routes.js';
import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import {
  ApiKeyAuthorizationError,
  type ApiKeyService,
} from '../src/modules/identity/api-key.service.js';

const migrations = [
  '0000_identity_tenancy.sql',
  '0001_solid_spiral.sql',
  '0002_busy_mantis.sql',
  '0003_many_marvel_boy.sql',
  '0004_easy_doctor_spectrum.sql',
  '0005_round_thunderball.sql',
  '0006_enforce_content_workspace_foreign_keys.sql',
  '0007_add_scheduler_attempt_ledger.sql',
  '0008_handy_shen.sql',
  '0009_generalize_oauth_transaction_secret.sql',
  '0016_common_barracuda.sql',
  '0025_lucky_legion.sql',
  '0019_media_retention_lifecycle.sql',
];
const workspaceId = '00000000-0000-4000-8000-000000000101';
const userId = '00000000-0000-4000-8000-000000000102';
let database: PGlite;

function encrypted(marker: number): EncryptedCredential {
  const bytes = (value: number) => Buffer.from([value]);
  return {
    keyVersion: `v${String(marker)}`,
    wrappedKey: bytes(marker),
    wrappedKeyNonce: bytes(2),
    wrappedKeyTag: bytes(3),
    ciphertext: bytes(4),
    nonce: bytes(5),
    tag: bytes(6),
  };
}

beforeEach(async () => {
  database = new PGlite();
  for (const migration of migrations)
    await database.exec(
      await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'),
    );
  await database.exec(`
    INSERT INTO workspaces (id, name, slug) VALUES ('${workspaceId}', 'Credential Workspace', 'credential-workspace');
    INSERT INTO users (id, email, password_hash) VALUES ('${userId}', 'credential@example.test', 'redacted');
    SELECT set_config('app.workspace_id', '${workspaceId}', false);
    INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${workspaceId}', '${userId}', 'owner');
  `);
});

afterEach(async () => database.close());

describe('credential and OAuth persistence', () => {
  it('rotates optimistically and revokes once without exposing plaintext fields', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const created = await withTenantTransaction(db, { workspaceId }, (tx) =>
      createCredential(tx, workspaceId, encrypted(1)),
    );
    expect(Object.keys(created)).not.toContain('plaintext');
    const [winner, loser] = await Promise.all([
      withTenantTransaction(db, { workspaceId }, (tx) =>
        rotateCredential(tx, workspaceId, created.id, 1, encrypted(2)),
      ),
      withTenantTransaction(db, { workspaceId }, (tx) =>
        rotateCredential(tx, workspaceId, created.id, 1, encrypted(3)),
      ),
    ]);
    expect([winner, loser].filter(Boolean)).toHaveLength(1);
    await expect(
      withTenantTransaction(db, { workspaceId }, (tx) =>
        revokeCredential(tx, workspaceId, created.id, new Date()),
      ),
    ).resolves.toBe(true);
    await expect(
      withTenantTransaction(db, { workspaceId }, (tx) =>
        revokeCredential(tx, workspaceId, created.id, new Date()),
      ),
    ).resolves.toBe(false);
  });

  it('consumes an unexpired OAuth state once and discovers multiple fake accounts', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const key = randomBytes(32);
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(key),
    };
    const issued = await issueOauthTransaction(db, keys, {
      workspaceId,
      userId,
      provider: 'fake',
      redirectUri: 'https://app.example.test/oauth/callback',
    });
    expect(issued.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    const persisted = await database.query<{ state_hash: string; redirect_uri: string }>(
      'select state_hash, redirect_uri from oauth_transactions',
    );
    expect(persisted.rows[0]?.state_hash).toBe(hashOauthState(issued.state));
    expect(JSON.stringify(persisted.rows[0])).not.toContain(issued.state);
    const attempts = await Promise.all([
      consumeOauthCallback(db, keys, { workspaceId, state: issued.state }),
      consumeOauthCallback(db, keys, { workspaceId, state: issued.state }),
    ]);
    const first = attempts.find(Boolean);
    expect(first?.provider).toBe('fake');
    expect(first?.redirectUri).toBe('https://app.example.test/oauth/callback');
    expect(
      createHash('sha256')
        .update(first?.codeVerifier ?? '')
        .digest('base64url'),
    ).toBe(issued.codeChallenge);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const secretCounts = await database.query<{ credentials: number; transactions: number }>(
      `select
        (select count(*)::int from credentials) as credentials,
        (select count(*)::int from oauth_transactions) as transactions`,
    );
    expect(secretCounts.rows[0]).toEqual({ credentials: 0, transactions: 0 });
    const adapter = new FakeProviderConnectionAdapter([
      { providerAccountId: 'one', displayName: 'One' },
      { providerAccountId: 'two', displayName: 'Two' },
    ]);
    await expect(adapter.discoverAccounts('never-persisted-token')).resolves.toHaveLength(2);
  });

  it('binds YouTube OAuth state and persists only encrypted credential and allowlisted accounts', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const key = randomBytes(32);
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(key),
    };
    const issued = await issueOauthTransaction(db, keys, {
      workspaceId,
      userId,
      provider: 'youtube',
      redirectUri: 'https://relay.test/youtube/callback',
    });
    await expect(
      consumeOauthCallback(db, keys, {
        workspaceId,
        state: issued.state,
        userId: '00000000-0000-4000-8000-000000000103',
        provider: 'youtube',
      }),
    ).resolves.toBeNull();
    await expect(
      consumeOauthCallback(db, keys, {
        workspaceId,
        state: issued.state,
        userId,
        provider: 'x',
      }),
    ).resolves.toBeNull();
    const credential = {
      accessToken: 'yt-access',
      refreshToken: 'yt-refresh',
      expiresAt: '2026-09-09T00:00:00.000Z',
      scope: 'youtube.upload',
    };
    let exchangeCalls = 0;
    const client = {
      exchangeCode: () => {
        exchangeCalls += 1;
        return Promise.resolve(credential);
      },
      discoverChannels: () =>
        Promise.resolve([{ id: 'channel-1', displayName: 'Channel One', privateField: 'discard' }]),
    };
    const connected = await completeYouTubeOauthConnection(db, keys, client as never, {
      workspaceId,
      userId,
      state: issued.state,
      code: 'code',
      requestId: 'youtube-connect',
    });
    expect(connected?.accounts).toEqual([
      { providerAccountId: 'channel-1', displayName: 'Channel One' },
    ]);
    await expect(
      completeYouTubeOauthConnection(db, keys, client as never, {
        workspaceId,
        userId,
        state: issued.state,
        code: 'code',
        requestId: 'youtube-replay',
      }),
    ).resolves.toBeNull();
    expect(exchangeCalls).toBe(1);
    const connection = await database.query<{ credential_id: string }>(
      "select credential_id from provider_connections where provider = 'youtube'",
    );
    const credentialId = connection.rows[0]?.credential_id;
    if (!credentialId) throw new Error('Expected persisted YouTube credential');
    const stored = await withTenantTransaction(db, { workspaceId }, (tx) =>
      getActiveCredential(tx, workspaceId, credentialId),
    );
    expect(stored).not.toBeNull();
    if (!stored) throw new Error('Expected active YouTube credential');
    const plaintext = await decryptCredential(stored, keys);
    try {
      expect(JSON.parse(plaintext.toString('utf8'))).toEqual(credential);
    } finally {
      plaintext.fill(0);
    }
    const accounts = await database.query<{ provider_account_id: string; display_name: string }>(
      'select provider_account_id, display_name from provider_accounts',
    );
    expect(accounts.rows).toEqual([
      { provider_account_id: 'channel-1', display_name: 'Channel One' },
    ]);

    const expiredAt = new Date('2026-09-01T00:00:00.000Z');
    const expired = await issueOauthTransaction(db, keys, {
      workspaceId,
      userId,
      provider: 'youtube',
      redirectUri: 'https://relay.test/youtube/callback',
      now: expiredAt,
    });
    await expect(
      consumeOauthCallback(db, keys, {
        workspaceId,
        state: expired.state,
        userId,
        provider: 'youtube',
        now: new Date(expiredAt.getTime() + 11 * 60 * 1000),
      }),
    ).resolves.toBeNull();
    expect(exchangeCalls).toBe(1);
  });

  it('removes abandoned OAuth transactions and their encrypted verifiers after expiry', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(randomBytes(32)),
    };
    const now = new Date('2026-08-31T12:00:00.000Z');
    await issueOauthTransaction(db, keys, {
      workspaceId,
      userId,
      provider: 'fake',
      redirectUri: 'https://app.example.test/oauth/callback',
      now,
    });
    await expect(
      cleanupExpiredOauthTransactions(db, workspaceId, new Date(now.getTime() + 11 * 60 * 1000)),
    ).resolves.toBe(1);
    const counts = await database.query<{ credentials: number; transactions: number }>(
      `select
        (select count(*)::int from credentials) as credentials,
        (select count(*)::int from oauth_transactions) as transactions`,
    );
    expect(counts.rows[0]).toEqual({ credentials: 0, transactions: 0 });
  });

  it('rechecks membership and reconnects the canonical provider connection', async () => {
    const key = randomBytes(32);
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(key),
    };
    const adapter = new FakeProviderConnectionAdapter([
      { providerAccountId: 'one', displayName: 'One' },
      { providerAccountId: 'two', displayName: 'Two' },
    ]);
    const db = drizzle(database) as unknown as NodePgDatabase;
    const first = await connectProvider(db, keys, adapter, {
      workspaceId,
      userId,
      provider: 'fake',
      accessToken: 'first-secret',
      requestId: 'req-connect',
    });
    const second = await connectProvider(db, keys, adapter, {
      workspaceId,
      userId,
      provider: 'fake',
      accessToken: 'second-secret',
      requestId: 'req-reconnect',
    });
    expect(second.connectionId).toBe(first.connectionId);
    const connectionCount = await database.query<{ count: number }>(
      'select count(*)::int as count from provider_connections',
    );
    const accountCount = await database.query<{ count: number }>(
      'select count(*)::int as count from provider_accounts',
    );
    const revokedCount = await database.query<{ count: number }>(
      'select count(*)::int as count from credentials where revoked_at is not null',
    );
    const auditRows = await database.query<{ action: string; metadata: { accountCount: number } }>(
      'select action, metadata from audit_events order by created_at',
    );
    expect(connectionCount.rows[0]?.count).toBe(1);
    expect(accountCount.rows[0]?.count).toBe(2);
    expect(revokedCount.rows[0]?.count).toBe(1);
    expect(auditRows.rows.map((row) => row.action)).toEqual([
      'provider.connected',
      'provider.reconnected',
    ]);
    expect(auditRows.rows[1]?.metadata).toEqual({ provider: 'fake', accountCount: 2 });
  });

  it('denies X connection before provider, OAuth, credential, or idempotency artifacts', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    let providerCalls = 0;
    let policyCalls = 0;
    const policy: ActionPolicy = {
      evaluate(context) {
        policyCalls += 1;
        expect(context).toMatchObject({
          workspaceId,
          actor: { type: 'user', id: userId },
          action: 'provider-account.connect',
          request: { provider: 'x', requestId: 'oauth-start' },
        });
        return Promise.resolve({ allowed: false, code: 'action_denied', reason: 'Not allowed' });
      },
    };
    const client = new XHttpClient({
      consumerKey: 'consumer-key',
      consumerSecret: 'consumer-secret',
      fetch: () => {
        providerCalls += 1;
        throw new Error('Provider must not be called');
      },
    });
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(randomBytes(32)),
    };

    await expect(
      beginXOauthConnection(
        db,
        keys,
        client,
        { workspaceId, userId, callbackUrl: 'https://app.test/callback', requestId: 'oauth-start' },
        policy,
      ),
    ).rejects.toMatchObject({ code: 'action_denied' });
    expect(policyCalls).toBe(1);
    expect(providerCalls).toBe(0);
    const counts = await database.query<{
      oauth_transactions: number;
      credentials: number;
      connections: number;
      accounts: number;
    }>(`select
      (select count(*)::int from oauth_transactions) oauth_transactions,
      (select count(*)::int from credentials) credentials,
      (select count(*)::int from provider_connections) connections,
      (select count(*)::int from provider_accounts) accounts`);
    expect(counts.rows[0]).toEqual({
      oauth_transactions: 0,
      credentials: 0,
      connections: 0,
      accounts: 0,
    });
  });

  it('consumes an encrypted X request-token secret once and creates the canonical connection', async () => {
    const key = randomBytes(32);
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(key),
    };
    const responses = [
      new Response(
        'oauth_token=request-token&oauth_token_secret=request-secret&oauth_callback_confirmed=true',
      ),
      new Response('oauth_token=access-token&oauth_token_secret=access-secret'),
      Response.json({
        data: { id: 'x-account', name: 'Example Editorial', username: 'example_editorial' },
      }),
    ];
    const client = new XHttpClient({
      consumerKey: 'consumer-key',
      consumerSecret: 'consumer-secret',
      fetch: () => {
        const response = responses.shift();
        if (!response) throw new Error('Unexpected X test request');
        return Promise.resolve(response);
      },
      nonce: () => 'nonce',
      now: () => Date.parse('2026-08-31T12:00:00.000Z'),
    });
    const db = drizzle(database) as unknown as NodePgDatabase;
    const begun = await beginXOauthConnection(db, keys, client, {
      workspaceId,
      userId,
      callbackUrl: 'https://app.example.test/oauth/x/callback',
    });
    expect(begun.authorizationUrl).toContain('oauth_token=request-token');
    const persisted = await database.query<{ state_hash: string; ciphertext: Uint8Array }>(
      `select transaction.state_hash, credential.ciphertext
       from oauth_transactions transaction
       join credentials credential on credential.id = transaction.secret_credential_id`,
    );
    expect(persisted.rows[0]?.state_hash).toBe(hashOauthState('request-token'));
    expect(JSON.stringify(persisted.rows[0])).not.toContain('request-secret');
    await expect(
      completeXOauthConnection(db, keys, client, {
        workspaceId,
        userId: '00000000-0000-4000-8000-000000000103',
        requestToken: 'request-token',
        verifier: 'verifier',
        requestId: 'x-connect-wrong-user',
      }),
    ).resolves.toBeNull();
    const connected = await completeXOauthConnection(db, keys, client, {
      workspaceId,
      userId,
      requestToken: 'request-token',
      verifier: 'verifier',
      requestId: 'x-connect',
    });
    expect(connected?.accounts).toEqual([
      { providerAccountId: 'x-account', displayName: 'Example Editorial (@example_editorial)' },
    ]);
    await expect(
      completeXOauthConnection(db, keys, client, {
        workspaceId,
        userId,
        requestToken: 'request-token',
        verifier: 'verifier',
        requestId: 'x-connect-retry',
      }),
    ).resolves.toBeNull();
    const counts = await database.query<{ transactions: number; active_credentials: number }>(
      `select
        (select count(*)::int from oauth_transactions) as transactions,
        (select count(*)::int from credentials where revoked_at is null) as active_credentials`,
    );
    expect(counts.rows[0]).toEqual({ transactions: 0, active_credentials: 1 });
  });

  it('lists an allowlisted account summary and revokes the final disconnected credential', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const key = randomBytes(32);
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(key),
    };
    await connectProvider(
      db,
      keys,
      new FakeProviderConnectionAdapter([
        {
          providerAccountId: 'external-account',
          displayName: 'Example Editorial (@exampleeditorial)',
        },
      ]),
      {
        workspaceId,
        userId,
        provider: 'x',
        accessToken: 'secret-token',
        requestId: 'req-connect-account',
      },
    );
    const foreignWorkspaceId = '00000000-0000-4000-8000-000000000191';
    const foreignAccountId = '00000000-0000-4000-8000-000000000194';
    await database.exec(`
      INSERT INTO workspaces (id, name, slug)
      VALUES ('${foreignWorkspaceId}', 'Foreign Workspace', 'foreign-workspace');
      SELECT set_config('app.workspace_id', '${foreignWorkspaceId}', false);
      INSERT INTO credentials (
        id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag,
        ciphertext, nonce, tag
      ) VALUES (
        '00000000-0000-4000-8000-000000000192', '${foreignWorkspaceId}',
        'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06'
      );
      INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
      VALUES (
        '00000000-0000-4000-8000-000000000193', '${foreignWorkspaceId}', 'x',
        '00000000-0000-4000-8000-000000000192'
      );
      INSERT INTO provider_accounts (
        id, workspace_id, connection_id, provider_account_id, display_name
      ) VALUES (
        '${foreignAccountId}', '${foreignWorkspaceId}',
        '00000000-0000-4000-8000-000000000193', 'foreign-account', 'Foreign Secret'
      );
      SELECT set_config('app.workspace_id', '${workspaceId}', false);
    `);
    const accounts = await listProviderAccounts(db, workspaceId);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      provider: 'x',
      displayName: 'Example Editorial (@exampleeditorial)',
      status: 'active',
    });
    expect(Object.keys(accounts[0] ?? {})).toEqual([
      'id',
      'provider',
      'displayName',
      'status',
      'adapterDefaults',
      'updatedAt',
    ]);
    const principal = {
      id: '00000000-0000-4000-8000-000000000501',
      workspaceId,
      createdByUserId: userId,
      workspaceLabel: 'Credential Workspace',
      prefix: 'pr_test',
      capabilities: ['destinations:read'],
      expiresAt: null,
    };
    const deniedPrincipal = {
      ...principal,
      id: '00000000-0000-4000-8000-000000000502',
      capabilities: [],
    };
    const apiKeys = {
      authenticate: (candidateWorkspaceId: string, token: string) =>
        Promise.resolve(
          candidateWorkspaceId === workspaceId && token === 'test-key'
            ? principal
            : candidateWorkspaceId === workspaceId && token === 'denied-key'
              ? deniedPrincipal
              : null,
        ),
      requireCapability: (candidate: typeof principal, capability: string) =>
        candidate.capabilities.includes(capability)
          ? Promise.resolve()
          : Promise.reject(new ApiKeyAuthorizationError('Missing capability')),
    } as unknown as ApiKeyService;
    const application = Fastify();
    registerDestinationRoutes(
      application,
      db,
      apiKeys,
      new ApiRateLimiter({
        workspace: 1,
        key: 1,
        mutationWorkspace: 1,
        mutationKey: 1,
        windowMs: 60_000,
      }),
    );
    const headers = { authorization: 'Bearer test-key', 'x-publish-relay-workspace': workspaceId };
    expect(
      (await application.inject({ method: 'GET', url: '/api/v1/destinations' })).statusCode,
    ).toBe(401);
    const deniedResponse = await application.inject({
      method: 'GET',
      url: '/api/v1/destinations',
      headers: { ...headers, authorization: 'Bearer denied-key' },
    });
    expect(deniedResponse.statusCode).toBe(403);
    expect(deniedResponse.json()).toMatchObject({
      success: false,
      error: { code: 'missing_capability', message: 'Missing capability' },
    });
    const destinationResponse = await application.inject({
      method: 'GET',
      url: '/api/v1/destinations',
      headers,
    });
    expect(destinationResponse.statusCode).toBe(200);
    const destinationBody = destinationResponse.json<{ data: { items: unknown[] } }>();
    expect(destinationBody.data.items).toEqual([
      {
        id: accounts[0]?.id,
        provider: 'x',
        displayName: 'Example Editorial (@exampleeditorial)',
        status: 'active',
        updatedAt: accounts[0]?.updatedAt.toISOString(),
      },
    ]);
    expect(JSON.stringify(destinationBody)).not.toMatch(
      /credentialId|connectionId|adapterDefaults|userId|secret/i,
    );
    expect(JSON.stringify(destinationBody)).not.toContain(foreignAccountId);
    expect(JSON.stringify(destinationBody)).not.toContain('Foreign Secret');
    expect(
      (await application.inject({ method: 'GET', url: '/api/v1/destinations', headers }))
        .statusCode,
    ).toBe(429);
    await application.close();
    const accountId = accounts[0]?.id ?? '';
    await database.exec(`
      INSERT INTO posts (id, workspace_id, created_by_user_id)
      VALUES ('00000000-0000-4000-8000-000000000201', '${workspaceId}', '${userId}');
      INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
      VALUES (
        '00000000-0000-4000-8000-000000000202',
        '${workspaceId}',
        '00000000-0000-4000-8000-000000000201',
        1,
        '{}'
      );
      INSERT INTO publication_jobs (
        id, workspace_id, post_id, revision_id, provider_account_id, state, scheduled_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000203',
        '${workspaceId}',
        '00000000-0000-4000-8000-000000000201',
        '00000000-0000-4000-8000-000000000202',
        '${accountId}',
        'scheduled',
        now()
      );
    `);
    await expect(
      disconnectProviderAccount(db, {
        workspaceId,
        userId,
        accountId,
        requestId: 'req-disconnect-active-account',
      }),
    ).resolves.toBe('scheduled');
    await database.exec(`
      UPDATE publication_jobs
      SET state = 'published'
      WHERE id = '00000000-0000-4000-8000-000000000203';
    `);
    await expect(
      disconnectProviderAccount(db, {
        workspaceId,
        userId,
        accountId,
        requestId: 'req-disconnect-account',
      }),
    ).resolves.toBe('disconnected');
    expect(await listProviderAccounts(db, workspaceId)).toEqual([]);
    const retainedJobs = await database.query<{ count: number }>(
      'select count(*)::int as count from publication_jobs',
    );
    expect(retainedJobs.rows[0]?.count).toBe(1);
    const revoked = await database.query<{ count: number }>(
      'select count(*)::int as count from credentials where revoked_at is not null',
    );
    expect(revoked.rows[0]?.count).toBe(1);
    await connectProvider(
      db,
      keys,
      new FakeProviderConnectionAdapter([
        { providerAccountId: 'external-account', displayName: 'Example Editorial reconnected' },
      ]),
      {
        workspaceId,
        userId,
        provider: 'x',
        accessToken: 'replacement-secret-token',
        requestId: 'req-reconnect-account',
      },
    );
    const reconnectedAccounts = await listProviderAccounts(db, workspaceId);
    expect(reconnectedAccounts).toHaveLength(1);
    expect(reconnectedAccounts[0]).toMatchObject({
      id: accountId,
      displayName: 'Example Editorial reconnected',
      status: 'active',
    });
    const historyAfterReconnect = await database.query<{ count: number }>(
      'select count(*)::int as count from publication_jobs',
    );
    expect(historyAfterReconnect.rows[0]?.count).toBe(1);
  });

  it('updates only tenant-owned active YouTube destination defaults', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const accountId = '00000000-0000-4000-8000-000000000701';
    await database.exec(`
      INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
        wrapped_key_tag, ciphertext, nonce, tag)
      VALUES ('00000000-0000-4000-8000-000000000702', '${workspaceId}',
        'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
      INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
      VALUES ('00000000-0000-4000-8000-000000000703', '${workspaceId}', 'youtube',
        '00000000-0000-4000-8000-000000000702');
      INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, display_name)
      VALUES ('${accountId}', '${workspaceId}', '00000000-0000-4000-8000-000000000703',
        'channel-1', 'Channel One');
    `);
    await expect(
      updateYouTubeAccountDefaults(db, {
        workspaceId,
        userId,
        accountId,
        requestId: 'defaults-1',
        defaults: { privacyStatus: 'public', madeForKids: false, notifySubscribers: true },
      }),
    ).resolves.toBe('updated');
    expect((await listProviderAccounts(db, workspaceId))[0]).toMatchObject({
      id: accountId,
      adapterDefaults: { privacyStatus: 'public', madeForKids: false, notifySubscribers: true },
    });
    expect(
      (
        await database.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM audit_events
       WHERE action = 'provider_account.defaults_updated' AND target_id = '${accountId}'`,
        )
      ).rows[0]?.count,
    ).toBe(1);
    await database.exec(`UPDATE provider_connections SET status = 'disconnected'
      WHERE id = '00000000-0000-4000-8000-000000000703'`);
    await expect(
      updateYouTubeAccountDefaults(db, {
        workspaceId,
        userId,
        accountId,
        requestId: 'defaults-inactive',
        defaults: {},
      }),
    ).resolves.toBe('missing');
    await database.exec(`UPDATE provider_connections SET status = 'active', provider = 'x'
      WHERE id = '00000000-0000-4000-8000-000000000703'`);
    await expect(
      updateYouTubeAccountDefaults(db, {
        workspaceId,
        userId,
        accountId,
        requestId: 'defaults-wrong-provider',
        defaults: {},
      }),
    ).resolves.toBe('missing');
    await database.exec(`UPDATE provider_connections SET provider = 'youtube';
      UPDATE provider_accounts SET disconnected_at = now() WHERE id = '${accountId}'`);
    await expect(
      updateYouTubeAccountDefaults(db, {
        workspaceId,
        userId,
        accountId,
        requestId: 'defaults-disconnected',
        defaults: {},
      }),
    ).resolves.toBe('missing');
    await expect(
      updateYouTubeAccountDefaults(db, {
        workspaceId,
        userId,
        accountId: '00000000-0000-4000-8000-000000000799',
        requestId: 'defaults-missing',
        defaults: {},
      }),
    ).resolves.toBe('missing');
  });
});
