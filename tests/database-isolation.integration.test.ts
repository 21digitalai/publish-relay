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
];
let database: PGlite;

beforeEach(async () => {
  database = new PGlite();
  for (const migrationUrl of migrationUrls)
    await database.exec(await readFile(migrationUrl, 'utf8'));
  await database.exec(`
    CREATE ROLE publish_relay_app NOLOGIN;
    GRANT USAGE ON SCHEMA public TO publish_relay_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO publish_relay_app;
  `);
});

afterEach(async () => database.close());

describe('PostgreSQL tenant isolation', () => {
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
    ).resolves.toEqual({ id: workspaceId, name: 'Atlas Studio', slug: 'atlas-studio' });
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
  });
});
