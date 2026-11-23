import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPostgresReviewerAccountStore } from '../src/modules/identity/reviewer-account.repository.js';
import { ReviewerAccountService } from '../src/modules/identity/reviewer-account.service.js';

let postgres: PGlite;
let service: ReviewerAccountService;
const workspace = '00000000-0000-4000-8000-000000000001';
const foreignWorkspace = '00000000-0000-4000-8000-000000000002';
const owner = '00000000-0000-4000-8000-000000000011';

beforeEach(async () => {
  postgres = new PGlite();
  await postgres.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), display_name text NOT NULL,
      email text NOT NULL UNIQUE, password_hash text, default_workspace_id uuid,
      is_disabled boolean NOT NULL DEFAULT false, review_access_expires_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE memberships (workspace_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL,
      PRIMARY KEY (workspace_id,user_id));
    CREATE TABLE sessions (workspace_id uuid NOT NULL, user_id uuid NOT NULL, revoked_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE api_keys (workspace_id uuid NOT NULL, created_by_user_id uuid NOT NULL,
      revoked_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE delegated_grants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
      user_id uuid NOT NULL, revoked_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE delegated_authorization_codes (workspace_id uuid NOT NULL, grant_id uuid NOT NULL,
      consumed_at timestamptz);
    CREATE TABLE delegated_tokens (workspace_id uuid NOT NULL, grant_id uuid NOT NULL,
      revoked_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE audit_events (workspace_id uuid NOT NULL, actor_type text NOT NULL,
      actor_id text NOT NULL, action text NOT NULL, target_type text NOT NULL, target_id text,
      request_id text NOT NULL, metadata jsonb NOT NULL);
  `);
  await postgres.query(
    "INSERT INTO users (id,display_name,email) VALUES ($1,'Owner','owner@example.test')",
    [owner],
  );
  await postgres.query("INSERT INTO memberships VALUES ($1,$2,'owner')", [workspace, owner]);
  service = new ReviewerAccountService(
    createPostgresReviewerAccountStore(drizzle(postgres) as unknown as NodePgDatabase),
  );
});

afterEach(async () => postgres.close());

describe('PostgreSQL reviewer lifecycle', () => {
  it('provisions an editor and atomically revokes every durable credential class', async () => {
    const provisioned = await service.provision({
      workspaceId: workspace,
      operatorUserId: owner,
      email: 'reviewer@example.test',
      requestId: 'provision-request',
      now: new Date('2026-11-23T12:00:00Z'),
    });
    const reviewer = await postgres.query<{
      role: string;
      password_hash: string | null;
      review_access_expires_at: Date | null;
    }>(
      'SELECT memberships.role, users.password_hash, users.review_access_expires_at FROM users JOIN memberships ON memberships.user_id=users.id WHERE users.id=$1',
      [provisioned.userId],
    );
    expect(reviewer.rows[0]).toMatchObject({ role: 'editor' });
    expect(reviewer.rows[0]?.password_hash).not.toBe(provisioned.password);
    expect(reviewer.rows[0]?.review_access_expires_at).not.toBeNull();
    const grant = '00000000-0000-4000-8000-000000000021';
    await postgres.query('INSERT INTO sessions VALUES ($1,$2,NULL,now())', [
      workspace,
      provisioned.userId,
    ]);
    await postgres.query('INSERT INTO api_keys VALUES ($1,$2,NULL,now())', [
      workspace,
      provisioned.userId,
    ]);
    await postgres.query('INSERT INTO delegated_grants VALUES ($1,$2,$3,NULL,now())', [
      grant,
      workspace,
      provisioned.userId,
    ]);
    await postgres.query('INSERT INTO delegated_authorization_codes VALUES ($1,$2,NULL)', [
      workspace,
      grant,
    ]);
    await postgres.query('INSERT INTO delegated_tokens VALUES ($1,$2,NULL,now())', [
      workspace,
      grant,
    ]);
    await service.revoke({
      workspaceId: workspace,
      operatorUserId: owner,
      email: 'reviewer@example.test',
      requestId: 'revoke-request',
    });
    const state = await postgres.query<{
      is_disabled: boolean;
      password_hash: string | null;
      review_access_expires_at: Date | null;
    }>('SELECT is_disabled,password_hash,review_access_expires_at FROM users WHERE id=$1', [
      provisioned.userId,
    ]);
    expect(state.rows[0]).toEqual({
      is_disabled: true,
      password_hash: null,
      review_access_expires_at: null,
    });
    for (const query of [
      'SELECT revoked_at FROM sessions',
      'SELECT revoked_at FROM api_keys',
      'SELECT consumed_at AS revoked_at FROM delegated_authorization_codes',
      'SELECT revoked_at FROM delegated_tokens',
      'SELECT revoked_at FROM delegated_grants',
    ]) {
      const rows = await postgres.query<{ revoked_at: Date | null }>(query);
      expect(rows.rows[0]?.revoked_at).not.toBeNull();
    }
    const audit = await postgres.query<{ action: string; actor_id: string }>(
      'SELECT action,actor_id FROM audit_events ORDER BY action',
    );
    expect(audit.rows).toEqual([
      { action: 'auth.reviewer.provisioned', actor_id: owner },
      { action: 'auth.reviewer.revoked', actor_id: owner },
    ]);
  });

  it('rolls back provisioning for non-owner and foreign-workspace operators', async () => {
    for (const workspaceId of [workspace, foreignWorkspace])
      await expect(
        service.provision({
          workspaceId,
          operatorUserId: '00000000-0000-4000-8000-000000000099',
          email: `${workspaceId}@example.test`,
          requestId: 'rejected',
        }),
      ).rejects.toThrow('Operator owner membership is required');
    const rows = await postgres.query("SELECT id FROM users WHERE email <> 'owner@example.test'");
    expect(rows.rows).toHaveLength(0);
    expect((await postgres.query('SELECT * FROM audit_events')).rows).toHaveLength(0);
  });
});
