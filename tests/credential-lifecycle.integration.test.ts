import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  createCredential,
  revokeCredential,
  rotateCredential,
} from '../src/modules/credentials/credential.repository.js';
import type {
  EncryptedCredential,
  MasterKeyProvider,
} from '../src/modules/credentials/envelope.js';
import { FakeProviderConnectionAdapter } from '../src/modules/credentials/provider-adapter.js';
import { connectProvider } from '../src/modules/credentials/provider-connection.service.js';
import {
  cleanupExpiredOauthTransactions,
  consumeOauthCallback,
  hashOauthState,
  issueOauthTransaction,
} from '../src/modules/credentials/oauth.service.js';

const migrations = [
  '0000_identity_tenancy.sql',
  '0001_solid_spiral.sql',
  '0002_busy_mantis.sql',
  '0003_many_marvel_boy.sql',
  '0004_easy_doctor_spectrum.sql',
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
});
