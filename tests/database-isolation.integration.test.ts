import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migrationUrl = new URL('../migrations/0000_identity_tenancy.sql', import.meta.url);
let database: PGlite;

beforeEach(async () => {
  database = new PGlite();
  await database.exec(await readFile(migrationUrl, 'utf8'));
  await database.exec(`
    CREATE ROLE publish_relay_app NOLOGIN;
    GRANT USAGE ON SCHEMA public TO publish_relay_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO publish_relay_app;
  `);
});

afterEach(async () => database.close());

describe('PostgreSQL tenant isolation', () => {
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
});
