import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  createPostgresApiKeyStore,
  findApiKeyByPrefix,
  revokeApiKey,
} from '../src/modules/identity/api-key.repository.js';
import { ApiKeyService } from '../src/modules/identity/api-key.service.js';
import { createPostgresAuthStore } from '../src/modules/identity/auth.repository.js';

const migrationUrls = [
  new URL('../migrations/0000_identity_tenancy.sql', import.meta.url),
  new URL('../migrations/0001_solid_spiral.sql', import.meta.url),
  new URL('../migrations/0002_busy_mantis.sql', import.meta.url),
  new URL('../migrations/0003_many_marvel_boy.sql', import.meta.url),
  new URL('../migrations/0004_easy_doctor_spectrum.sql', import.meta.url),
  new URL('../migrations/0023_clear_shocker.sql', import.meta.url),
  new URL('../migrations/0042_long_pepper_potts.sql', import.meta.url),
  new URL('../migrations/0043_workspace_membership_listing.sql', import.meta.url),
  new URL('../migrations/0058_workspace_tombstone.sql', import.meta.url),
  new URL('../migrations/0076_api_key_capability_version.sql', import.meta.url),
  new URL('../migrations/0131_reviewer_access_expiry.sql', import.meta.url),
];
let database: PGlite;

beforeEach(async () => {
  database = new PGlite();
  for (const migrationUrl of migrationUrls)
    await database.exec(await readFile(migrationUrl, 'utf8'));
  await database.exec(`
    CREATE ROLE publish_relay_app NOLOGIN NOBYPASSRLS;
    CREATE ROLE publish_relay_worker NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO publish_relay_app, publish_relay_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO publish_relay_app, publish_relay_worker;
    GRANT EXECUTE ON FUNCTION public.list_user_workspaces(uuid) TO publish_relay_app;
    GRANT EXECUTE ON FUNCTION public.workspace_deletion_blocker(uuid) TO publish_relay_app;
  `);
});

afterEach(async () => database.close());

describe('PostgreSQL tenant isolation', () => {
  it('persists create, default switch, scoped account ownership, and reordered workspace state', async () => {
    const firstWorkspaceId = '00000000-0000-4000-8000-000000000071';
    const userId = '00000000-0000-4000-8000-000000000072';
    const currentTokenHash = 'a'.repeat(64);
    await database.exec(`
      INSERT INTO workspaces (id, name, slug)
        VALUES ('${firstWorkspaceId}', 'First Workspace', 'first-workspace');
      INSERT INTO users (id, email, password_hash, default_workspace_id)
        VALUES ('${userId}', 'multi@example.test', 'redacted-hash', '${firstWorkspaceId}');
      SELECT set_config('app.workspace_id', '${firstWorkspaceId}', false);
      INSERT INTO memberships (workspace_id, user_id, role, position)
        VALUES ('${firstWorkspaceId}', '${userId}', 'owner', 0);
      INSERT INTO sessions (workspace_id, user_id, token_hash, csrf_secret_hash, expires_at)
        VALUES ('${firstWorkspaceId}', '${userId}', '${currentTokenHash}', '${'b'.repeat(64)}', now() + interval '1 day');
      RESET app.workspace_id;
      SET ROLE publish_relay_app;
    `);
    const store = createPostgresAuthStore(drizzle(database) as unknown as NodePgDatabase);
    const created = await store.createWorkspace(userId, 'Second Workspace', 1);
    await database.exec(`
      SELECT set_config('app.workspace_id', '${created.id}', false);
      INSERT INTO credentials (
        workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag,
        ciphertext, nonce, tag
      ) VALUES ('${created.id}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
      INSERT INTO provider_connections (workspace_id, provider, credential_id)
        SELECT '${created.id}', 'x', id FROM credentials WHERE workspace_id = '${created.id}';
      INSERT INTO provider_accounts (
        workspace_id, connection_id, provider_account_id, display_name
      ) SELECT '${created.id}', id, 'second-account', 'Second Account'
        FROM provider_connections WHERE workspace_id = '${created.id}';
    `);
    await expect(
      store.rotateWorkspaceSession({
        currentWorkspaceId: firstWorkspaceId,
        currentTokenHash,
        targetWorkspaceId: created.id,
        userId,
        tokenHash: 'c'.repeat(64),
        csrfSecretHash: 'd'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toMatchObject({ workspaceId: created.id });
    await store.reorderWorkspaces(userId, [created.id, firstWorkspaceId]);

    const reloadedStore = createPostgresAuthStore(drizzle(database) as unknown as NodePgDatabase);
    await database.exec('RESET app.workspace_id;');
    await expect(reloadedStore.listWorkspaces(userId)).resolves.toMatchObject([
      { id: created.id, position: 0 },
      { id: firstWorkspaceId, position: 1 },
    ]);
    await database.exec(`SELECT set_config('app.workspace_id', '${created.id}', false);`);
    const defaultWorkspace = await database.query<{ default_workspace_id: string }>(
      `SELECT default_workspace_id FROM users WHERE id = '${userId}'`,
    );
    expect(defaultWorkspace.rows[0]?.default_workspace_id).toBe(created.id);
    const secondAccounts = await database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM provider_accounts',
    );
    expect(secondAccounts.rows[0]?.count).toBe(1);
    await database.exec(`SELECT set_config('app.workspace_id', '${firstWorkspaceId}', false);`);
    const firstAccounts = await database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM provider_accounts',
    );
    expect(firstAccounts.rows[0]?.count).toBe(0);
  });

  it('returns only the authenticated tenant shell profile', async () => {
    const workspaceA = '00000000-0000-4000-8000-000000000061';
    const workspaceB = '00000000-0000-4000-8000-000000000062';
    const userA = '00000000-0000-4000-8000-000000000063';
    const userB = '00000000-0000-4000-8000-000000000064';
    await database.exec(`
      ALTER TABLE users ADD COLUMN display_name text NOT NULL DEFAULT 'Test Operator';
      INSERT INTO users (id, display_name, email, password_hash) VALUES
        ('${userA}', 'Local Operator', 'local@example.test', 'hash-a'),
        ('${userB}', 'Hidden Operator', 'hidden@example.test', 'hash-b');
      INSERT INTO workspaces (id, name, slug) VALUES
        ('${workspaceA}', 'Local Test', 'local-test'),
        ('${workspaceB}', 'Hidden Tenant', 'hidden-tenant');
      SELECT set_config('app.workspace_id', '${workspaceA}', false);
      INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${workspaceA}', '${userA}', 'owner');
      SELECT set_config('app.workspace_id', '${workspaceB}', false);
      INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${workspaceB}', '${userB}', 'owner');
      RESET app.workspace_id;
      SET ROLE publish_relay_app;
    `);
    const store = createPostgresAuthStore(drizzle(database) as unknown as NodePgDatabase);

    await expect(store.findShellProfile(workspaceA, userA)).resolves.toEqual({
      user: { displayName: 'Local Operator', email: 'local@example.test' },
      workspace: {
        id: workspaceA,
        name: 'Local Test',
        slug: 'local-test',
        role: 'owner',
        position: 0,
      },
    });
    await expect(store.findShellProfile(workspaceA, userB)).resolves.toBeNull();
  });
  it('updates the registered workspace profile in place without creating a duplicate', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000041';
    const userId = '00000000-0000-4000-8000-000000000042';
    await database.exec(`
      INSERT INTO users (id, email, password_hash) VALUES ('${userId}', 'profile@example.test', 'redacted-hash');
      INSERT INTO workspaces (id, name, slug) VALUES ('${workspaceId}', 'Initial', 'initial');
      SELECT set_config('app.workspace_id', '${workspaceId}', false);
      INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${workspaceId}', '${userId}', 'owner');
      RESET app.workspace_id;
      SET ROLE publish_relay_app;
    `);
    const store = createPostgresAuthStore(drizzle(database) as unknown as NodePgDatabase);

    await expect(
      store.updateWorkspace(workspaceId, userId, {
        name: 'Atlas Studio',
        slug: 'atlas-studio',
      }),
    ).resolves.toEqual({
      id: workspaceId,
      name: 'Atlas Studio',
      slug: 'atlas-studio',
      timezone: 'UTC',
    });
    await database.exec(`RESET ROLE;`);
    const result = await database.query<{ count: number; name: string; slug: string }>(
      'SELECT count(*)::int AS count, max(name) AS name, max(slug) AS slug FROM workspaces',
    );
    expect(result.rows[0]).toEqual({ count: 1, name: 'Atlas Studio', slug: 'atlas-studio' });
  });

  it('bootstraps login through the user default workspace before forced RLS membership access', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000031';
    const userId = '00000000-0000-4000-8000-000000000032';
    await database.exec(`
      INSERT INTO workspaces (id, name, slug) VALUES ('${workspaceId}', 'Login Workspace', 'login-workspace');
      INSERT INTO users (id, email, password_hash, default_workspace_id)
        VALUES ('${userId}', 'login@example.test', 'redacted-hash', '${workspaceId}');
      SELECT set_config('app.workspace_id', '${workspaceId}', false);
      INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${workspaceId}', '${userId}', 'owner');
      RESET app.workspace_id;
      SET ROLE publish_relay_app;
    `);
    const store = createPostgresAuthStore(drizzle(database) as unknown as NodePgDatabase);

    await expect(store.findLogin('login@example.test')).resolves.toEqual({
      userId,
      passwordHash: 'redacted-hash',
      workspaceId,
      role: 'owner',
    });
  });

  it('migrates an empty database and denies cross-workspace reads and writes', async () => {
    const workspaceA = '00000000-0000-4000-8000-000000000001';
    const workspaceB = '00000000-0000-4000-8000-000000000002';
    const userId = '00000000-0000-4000-8000-000000000003';
    await database.exec(`
      INSERT INTO users (id, email, password_hash) VALUES ('${userId}', 'owner@example.test', 'redacted-hash');
      INSERT INTO workspaces (id, name, slug) VALUES
        ('${workspaceA}', 'Workspace A', 'workspace-a'),
        ('${workspaceB}', 'Workspace B', 'workspace-b');
      INSERT INTO api_keys (workspace_id, created_by_user_id, label, prefix, secret_hash)
        VALUES ('${workspaceA}', '${userId}', 'A key', 'pr_a', 'hash-a');
      SET ROLE publish_relay_app;
      SELECT set_config('app.workspace_id', '${workspaceB}', false);
    `);

    const hidden = await database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM api_keys',
    );
    expect(hidden.rows[0]?.count).toBe(0);
    await expect(
      database.exec(
        `INSERT INTO api_keys (workspace_id, created_by_user_id, label, prefix, secret_hash) VALUES ('${workspaceA}', '${userId}', 'cross tenant', 'pr_cross', 'hash')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('allows only the worker authority to discover work across forced-RLS tenants', async () => {
    const workspaceA = '00000000-0000-4000-8000-000000000051';
    const workspaceB = '00000000-0000-4000-8000-000000000052';
    const userId = '00000000-0000-4000-8000-000000000053';
    await database.exec(`
      INSERT INTO users (id, email, password_hash) VALUES ('${userId}', 'worker@example.test', 'redacted-hash');
      INSERT INTO workspaces (id, name, slug) VALUES
        ('${workspaceA}', 'Worker A', 'worker-a'),
        ('${workspaceB}', 'Worker B', 'worker-b');
      INSERT INTO api_keys (workspace_id, created_by_user_id, label, prefix, secret_hash) VALUES
        ('${workspaceA}', '${userId}', 'A', 'pr_worker_a', 'hash-a'),
        ('${workspaceB}', '${userId}', 'B', 'pr_worker_b', 'hash-b');
      SET ROLE publish_relay_app;
      SELECT set_config('app.workspace_id', '${workspaceA}', false);
    `);
    const webRows = await database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM api_keys',
    );
    expect(webRows.rows[0]?.count).toBe(1);

    await database.exec('RESET ROLE; SET ROLE publish_relay_worker; RESET app.workspace_id;');
    const workerRows = await database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM api_keys',
    );
    expect(workerRows.rows[0]?.count).toBe(2);

    const repositoryDatabase = drizzle(database) as unknown as NodePgDatabase;
    const scopedMutation = await withTenantTransaction(
      repositoryDatabase,
      { workspaceId: workspaceA },
      (transaction) =>
        revokeApiKey(transaction, workspaceA, '00000000-0000-0000-0000-000000000000', new Date()),
    );
    expect(scopedMutation).toBe(false);
  });

  it('permits rows in the active workspace and prevents audit mutation', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000011';
    const userId = '00000000-0000-4000-8000-000000000012';
    await database.exec(`
      INSERT INTO users (id, email, password_hash) VALUES ('${userId}', 'audit@example.test', 'redacted-hash');
      INSERT INTO workspaces (id, name, slug) VALUES ('${workspaceId}', 'Audit Workspace', 'audit-workspace');
      SET ROLE publish_relay_app;
      SELECT set_config('app.workspace_id', '${workspaceId}', false);
      INSERT INTO audit_events (workspace_id, actor_type, actor_id, action, target_type, request_id)
        VALUES ('${workspaceId}', 'user', '${userId}', 'workspace.created', 'workspace', 'req-1');
    `);
    const visible = await database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM audit_events',
    );
    expect(visible.rows[0]?.count).toBe(1);
    await expect(database.exec(`UPDATE audit_events SET action = 'tampered'`)).rejects.toThrow(
      /append-only/i,
    );
  });

  it('enforces explicit workspace scope through the repository and tenant transaction', async () => {
    const workspaceA = '00000000-0000-4000-8000-000000000021';
    const workspaceB = '00000000-0000-4000-8000-000000000022';
    const userId = '00000000-0000-4000-8000-000000000023';
    await database.exec(`
      INSERT INTO users (id, email, password_hash) VALUES ('${userId}', 'repository@example.test', 'redacted-hash');
      INSERT INTO workspaces (id, name, slug) VALUES ('${workspaceA}', 'Repository A', 'repository-a'), ('${workspaceB}', 'Repository B', 'repository-b');
      INSERT INTO api_keys (workspace_id, created_by_user_id, label, prefix, secret_hash) VALUES ('${workspaceA}', '${userId}', 'A key', 'pr_repository', 'hash-a');
      SET ROLE publish_relay_app;
    `);
    const repositoryDatabase = drizzle(database) as unknown as NodePgDatabase;
    const visible = await withTenantTransaction(
      repositoryDatabase,
      { workspaceId: workspaceA },
      (transaction) => findApiKeyByPrefix(transaction, workspaceA, 'pr_repository'),
    );
    expect(visible?.workspaceId).toBe(workspaceA);
    const hidden = await withTenantTransaction(
      repositoryDatabase,
      { workspaceId: workspaceB },
      (transaction) => findApiKeyByPrefix(transaction, workspaceB, 'pr_repository'),
    );
    expect(hidden).toBeNull();
    if (!visible) throw new Error('Expected workspace-scoped API key to be visible');
    const revoked = await withTenantTransaction(
      repositoryDatabase,
      { workspaceId: workspaceB },
      (transaction) => revokeApiKey(transaction, workspaceB, visible.id, new Date()),
    );
    expect(revoked).toBe(false);
  });

  it('creates, authenticates, audits, and rejects an expected-workspace mismatch', async () => {
    const workspaceA = '00000000-0000-4000-8000-000000000041';
    const workspaceB = '00000000-0000-4000-8000-000000000042';
    const userId = '00000000-0000-4000-8000-000000000043';
    await database.exec(`
      INSERT INTO users (id, email, password_hash) VALUES ('${userId}', 'api-key@example.test', 'redacted-hash');
      INSERT INTO workspaces (id, name, slug) VALUES
        ('${workspaceA}', 'API Workspace A', 'api-workspace-a'),
        ('${workspaceB}', 'API Workspace B', 'api-workspace-b');
      SET ROLE publish_relay_app;
    `);
    const service = new ApiKeyService(
      createPostgresApiKeyStore(drizzle(database) as unknown as NodePgDatabase),
    );
    const created = await service.create({
      workspaceId: workspaceA,
      createdByUserId: userId,
      label: 'Automation',
      capabilities: ['schedules:read'],
      requestId: 'request-create',
    });
    await expect(service.authenticate(workspaceB, created.token)).resolves.toBeNull();
    await expect(service.authenticate(workspaceA, created.token)).resolves.toMatchObject({
      id: created.key.id,
      workspaceId: workspaceA,
      workspaceLabel: 'API Workspace A',
      capabilities: ['schedules:read'],
    });
    await withTenantTransaction(
      drizzle(database) as unknown as NodePgDatabase,
      { workspaceId: workspaceA },
      async (transaction) => {
        const result = await transaction.execute(
          sql`select count(*)::int as count from audit_events where action = 'api_key.created'`,
        );
        expect(result.rows[0]).toMatchObject({ count: 1 });
      },
    );
    await database.exec(`UPDATE workspaces SET deleted_at = now() WHERE id = '${workspaceA}'`);
    await expect(service.authenticate(workspaceA, created.token)).resolves.toBeNull();
  });

  it('replaces key permissions atomically with version conflicts and immediate authentication effect', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000051';
    const otherWorkspaceId = '00000000-0000-4000-8000-000000000052';
    const userId = '00000000-0000-4000-8000-000000000053';
    await database.exec(`
      INSERT INTO users (id, email, password_hash) VALUES ('${userId}', 'edit-key@example.test', 'hash');
      INSERT INTO workspaces (id, name, slug) VALUES
        ('${workspaceId}', 'Key Workspace', 'key-workspace'),
        ('${otherWorkspaceId}', 'Other Workspace', 'other-workspace');
      SET ROLE publish_relay_app;
    `);
    const service = new ApiKeyService(
      createPostgresApiKeyStore(drizzle(database) as unknown as NodePgDatabase),
    );
    const created = await service.create({
      workspaceId,
      createdByUserId: userId,
      label: 'Agent',
      capabilities: ['schedules:read'],
      requestId: 'create',
    });
    const input = {
      workspaceId,
      keyId: created.key.id,
      updatedByUserId: userId,
      expectedVersion: 1,
      capabilities: ['schedules:write'],
      requestId: 'edit',
    };
    await expect(
      service.updateCapabilities({ ...input, workspaceId: otherWorkspaceId }),
    ).resolves.toBe('not_found');
    await expect(service.updateCapabilities(input)).resolves.toBe('updated');
    await expect(service.authenticate(workspaceId, created.token)).resolves.toMatchObject({
      capabilities: ['schedules:write'],
    });
    await expect(service.updateCapabilities(input)).resolves.toBe('conflict');
    await withTenantTransaction(
      drizzle(database) as unknown as NodePgDatabase,
      { workspaceId },
      async (transaction) => {
        const version = await transaction.execute(
          sql`SELECT capability_version FROM api_keys WHERE id = ${created.key.id}::uuid`,
        );
        expect(version.rows[0]).toMatchObject({ capability_version: 2 });
        const audit = await transaction.execute(
          sql`SELECT metadata FROM audit_events WHERE action = 'api_key.capabilities_changed'`,
        );
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0]).toMatchObject({
          metadata: { oldCapabilities: ['schedules:read'], newCapabilities: ['schedules:write'] },
        });
      },
    );
    await service.revoke({
      workspaceId,
      keyId: created.key.id,
      revokedByUserId: userId,
      requestId: 'revoke',
    });
    await expect(service.updateCapabilities({ ...input, expectedVersion: 2 })).resolves.toBe(
      'conflict',
    );
    await expect(service.authenticate(workspaceId, created.token)).resolves.toBeNull();
  });

  it('tombstones only an empty owned non-current workspace and invalidates its sessions', async () => {
    const current = '00000000-0000-4000-8000-000000000081';
    const target = '00000000-0000-4000-8000-000000000082';
    const userId = '00000000-0000-4000-8000-000000000083';
    await database.exec(`
      INSERT INTO workspaces (id, name, slug) VALUES
        ('${current}', 'Current', 'current-workspace'),
        ('${target}', 'Empty Test', 'empty-test');
      INSERT INTO users (id, email, password_hash, default_workspace_id)
        VALUES ('${userId}', 'delete@example.test', 'hash', '${target}');
      SELECT set_config('app.workspace_id', '${current}', false);
      INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${current}', '${userId}', 'owner');
      SELECT set_config('app.workspace_id', '${target}', false);
      INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${target}', '${userId}', 'owner');
      INSERT INTO sessions (workspace_id, user_id, token_hash, csrf_secret_hash, expires_at)
        VALUES ('${target}', '${userId}', '${'e'.repeat(64)}', '${'f'.repeat(64)}', now() + interval '1 day');
      RESET app.workspace_id;
      SET ROLE publish_relay_app;
    `);
    const store = createPostgresAuthStore(drizzle(database) as unknown as NodePgDatabase);
    const deletion = { userId, currentWorkspaceId: current, targetWorkspaceId: target };
    await expect(store.deleteWorkspace({ ...deletion, confirmedName: 'Wrong' })).resolves.toBe(
      'Workspace name confirmation does not match',
    );
    await withTenantTransaction(
      drizzle(database) as unknown as NodePgDatabase,
      { workspaceId: target },
      async (transaction) => {
        await transaction.execute(sql`INSERT INTO api_keys
          (workspace_id, created_by_user_id, label, prefix, secret_hash)
          VALUES (${target}::uuid, ${userId}::uuid, 'Blocker', 'pr_blocker', 'hash')`);
      },
    );
    await expect(store.deleteWorkspace({ ...deletion, confirmedName: 'Empty Test' })).resolves.toBe(
      'Workspace has active sessions',
    );
    await withTenantTransaction(
      drizzle(database) as unknown as NodePgDatabase,
      { workspaceId: target },
      async (transaction) => {
        await transaction.execute(sql`UPDATE sessions SET expires_at = now() - interval '1 second'
          WHERE workspace_id = ${target}::uuid`);
      },
    );
    await expect(store.deleteWorkspace({ ...deletion, confirmedName: 'Empty Test' })).resolves.toBe(
      'Workspace has API keys',
    );
    await withTenantTransaction(
      drizzle(database) as unknown as NodePgDatabase,
      { workspaceId: target },
      async (transaction) => {
        await transaction.execute(sql`DELETE FROM api_keys WHERE workspace_id = ${target}::uuid`);
        await transaction.execute(sql`INSERT INTO credentials
          (workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag,
           ciphertext, nonce, tag)
          VALUES (${target}::uuid, 'v1', decode('01','hex'), decode('02','hex'),
                  decode('03','hex'), decode('04','hex'), decode('05','hex'), decode('06','hex'))`);
      },
    );
    await expect(store.deleteWorkspace({ ...deletion, confirmedName: 'Empty Test' })).resolves.toBe(
      'Workspace has credentials',
    );
    await withTenantTransaction(
      drizzle(database) as unknown as NodePgDatabase,
      { workspaceId: target },
      async (transaction) => {
        await transaction.execute(
          sql`DELETE FROM credentials WHERE workspace_id = ${target}::uuid`,
        );
      },
    );
    await expect(
      store.deleteWorkspace({ ...deletion, confirmedName: 'Empty Test' }),
    ).resolves.toBeNull();
    await expect(store.listWorkspaces(userId)).resolves.toMatchObject([{ id: current }]);
    await expect(store.findSession(target, 'e'.repeat(64))).resolves.toBeNull();
    await expect(
      store.rotateWorkspaceSession({
        currentWorkspaceId: current,
        currentTokenHash: 'e'.repeat(64),
        targetWorkspaceId: target,
        userId,
        tokenHash: 'g'.repeat(64),
        csrfSecretHash: 'h'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toBeNull();
    await expect(store.deleteWorkspace({ ...deletion, confirmedName: 'Empty Test' })).resolves.toBe(
      'Workspace was not found',
    );
    await database.exec(`RESET ROLE`);
    const result = await database.query<{ default_workspace_id: string; deleted_at: Date }>(
      `SELECT "default_workspace_id", (SELECT "deleted_at" FROM workspaces WHERE id = '${target}') AS deleted_at
       FROM users WHERE id = '${userId}'`,
    );
    expect(result.rows[0]?.default_workspace_id).toBe(current);
    expect(result.rows[0]?.deleted_at).toBeTruthy();
  });

  it('refuses editor deletion and hides the dependency scanner from other tenants', async () => {
    const current = '00000000-0000-4000-8000-000000000091';
    const target = '00000000-0000-4000-8000-000000000092';
    const userId = '00000000-0000-4000-8000-000000000093';
    const stranger = '00000000-0000-4000-8000-000000000094';
    await database.exec(`
      INSERT INTO workspaces (id, name, slug) VALUES
        ('${current}', 'Current', 'editor-current'), ('${target}', 'Target', 'editor-target');
      INSERT INTO users (id, email, password_hash) VALUES
        ('${userId}', 'editor@example.test', 'hash'),
        ('${stranger}', 'stranger@example.test', 'hash');
      SELECT set_config('app.workspace_id', '${current}', false);
      INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${current}', '${userId}', 'owner');
      SELECT set_config('app.workspace_id', '${target}', false);
      INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${target}', '${userId}', 'editor');
      RESET app.workspace_id;
      SET ROLE publish_relay_app;
    `);
    const store = createPostgresAuthStore(drizzle(database) as unknown as NodePgDatabase);
    await expect(
      store.deleteWorkspace({
        userId,
        currentWorkspaceId: current,
        targetWorkspaceId: target,
        confirmedName: 'Target',
      }),
    ).resolves.toBe('Only an owner can delete this workspace');
    await expect(
      store.deleteWorkspace({
        userId: stranger,
        currentWorkspaceId: current,
        targetWorkspaceId: target,
        confirmedName: 'Target',
      }),
    ).resolves.toBe('Workspace was not found');
    await expect(
      withTenantTransaction(
        drizzle(database) as unknown as NodePgDatabase,
        { workspaceId: target, userId: stranger },
        (transaction) =>
          transaction.execute(sql`SELECT public.workspace_deletion_blocker(${target}::uuid)`),
      ),
    ).rejects.toThrow('Failed query');
  });
});
