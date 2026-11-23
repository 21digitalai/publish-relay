import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPostgresAuthStore } from '../src/modules/identity/auth.repository.js';

let postgres: PGlite;

beforeEach(async () => {
  postgres = new PGlite();
  await postgres.exec(`
    CREATE TABLE workspaces (
      id uuid PRIMARY KEY, deleted_at timestamptz
    );
    CREATE TABLE users (
      id uuid PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text,
      default_workspace_id uuid, is_disabled boolean NOT NULL DEFAULT false,
      review_access_expires_at timestamptz
    );
    CREATE TABLE memberships (
      workspace_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    );
    ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
    ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
    CREATE POLICY membership_workspace ON memberships
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
  `);
});

afterEach(async () => postgres.close());

describe('PostgreSQL reviewer login lookup', () => {
  it('admits only an enabled unexpired editor in the active default workspace', async () => {
    const workspace = '00000000-0000-4000-8000-000000000001';
    const otherWorkspace = '00000000-0000-4000-8000-000000000002';
    await postgres.query('INSERT INTO workspaces (id) VALUES ($1), ($2)', [
      workspace,
      otherWorkspace,
    ]);
    const fixtures = [
      ['00000000-0000-4000-8000-000000000011', 'valid@example.test', workspace, false, '2099-01-01T00:00:00Z'],
      ['00000000-0000-4000-8000-000000000012', 'expired@example.test', workspace, false, '2020-01-01T00:00:00Z'],
      ['00000000-0000-4000-8000-000000000013', 'disabled@example.test', workspace, true, '2099-01-01T00:00:00Z'],
      ['00000000-0000-4000-8000-000000000014', 'owner@example.test', workspace, false, '2099-01-01T00:00:00Z'],
      ['00000000-0000-4000-8000-000000000015', 'wrong-workspace@example.test', workspace, false, '2099-01-01T00:00:00Z'],
    ] as const;
    for (const [id, email, defaultWorkspaceId, disabled, expiresAt] of fixtures)
      await postgres.query(
        'INSERT INTO users (id, email, password_hash, default_workspace_id, is_disabled, review_access_expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, email, 'hash', defaultWorkspaceId, disabled, expiresAt],
      );
    await postgres.query(
      "INSERT INTO memberships VALUES ($1,$2,'editor'), ($1,$3,'owner'), ($4,$5,'editor')",
      [workspace, fixtures[0][0], fixtures[3][0], otherWorkspace, fixtures[4][0]],
    );
    const database = drizzle(postgres) as unknown as NodePgDatabase;
    const store = createPostgresAuthStore(database);
    await expect(store.findReviewerLogin('valid@example.test', new Date())).resolves.toMatchObject({
      userId: fixtures[0][0],
      workspaceId: workspace,
      role: 'editor',
      passwordHash: 'hash',
    });
    for (const email of [
      'expired@example.test',
      'disabled@example.test',
      'owner@example.test',
      'wrong-workspace@example.test',
    ])
      await expect(store.findReviewerLogin(email, new Date())).resolves.toBeNull();
    await postgres.query('UPDATE workspaces SET deleted_at=now() WHERE id=$1', [workspace]);
    await expect(store.findReviewerLogin('valid@example.test', new Date())).resolves.toBeNull();
  });
});
