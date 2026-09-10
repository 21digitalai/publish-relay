import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migrations = [
  new URL('../migrations/0000_identity_tenancy.sql', import.meta.url),
  new URL('../migrations/0028_nosy_dracula.sql', import.meta.url),
  new URL('../migrations/0029_handy_human_fly.sql', import.meta.url),
];

let database: PGlite;

beforeEach(async () => {
  database = new PGlite();
  for (const migration of migrations) await database.exec(await readFile(migration, 'utf8'));
  await database.exec(`
    CREATE ROLE publish_relay_app NOLOGIN NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO publish_relay_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO publish_relay_app;
  `);
});

afterEach(async () => database.close());

describe('delegated authorization persistence', () => {
  it('isolates every grant-owned credential artifact by workspace', async () => {
    await seedGrant('00000000-0000-4000-8000-000000000101');
    await database.exec(`
      SET ROLE publish_relay_app;
      SELECT set_config('app.workspace_id', '00000000-0000-4000-8000-000000000102', false);
    `);

    for (const table of ['delegated_grants', 'delegated_authorization_codes', 'delegated_tokens']) {
      const result = await database.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table}`,
      );
      expect(result.rows[0]?.count).toBe(0);
    }
  });

  it('allows only one active grant per workspace user and client, but permits reconnect after revocation', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000111';
    await seedGrant(workspaceId);
    await expect(seedGrant(workspaceId)).rejects.toThrow(/delegated_grants_active_identity_unique/);
    await database.exec(`
      UPDATE delegated_grants SET revoked_at = now() WHERE workspace_id = '${workspaceId}';
    `);
    await expect(seedGrant(workspaceId, false)).resolves.toBeUndefined();
  });

  it('rejects duplicate authorization, access, and refresh hashes', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000121';
    await seedGrant(workspaceId);
    await expect(seedArtifacts(workspaceId)).rejects.toThrow(/unique/);
  });
});

async function seedGrant(workspaceId: string, includeArtifacts = true): Promise<void> {
  await database.exec(`
    INSERT INTO workspaces (id, name, slug) VALUES
      ('${workspaceId}', 'Workspace', '${workspaceId}') ON CONFLICT DO NOTHING;
    INSERT INTO users (id, email, password_hash) VALUES
      ('00000000-0000-4000-8000-000000000199', 'owner@example.test', 'hash') ON CONFLICT DO NOTHING;
    INSERT INTO registered_clients (id, display_name, client_type, redirect_uris, allowed_scopes)
      VALUES ('open-clips-dev', 'Open Clips', 'public', ARRAY['http://127.0.0.1/callback'], ARRAY['destinations:read'])
      ON CONFLICT DO NOTHING;
    INSERT INTO delegated_grants (id, workspace_id, user_id, client_id, scopes) VALUES
      (gen_random_uuid(), '${workspaceId}', '00000000-0000-4000-8000-000000000199', 'open-clips-dev', ARRAY['destinations:read']);
  `);
  if (includeArtifacts) await seedArtifacts(workspaceId);
}

async function seedArtifacts(workspaceId: string): Promise<void> {
  const grant = await database.query<{ id: string }>(
    `SELECT id FROM delegated_grants WHERE workspace_id = '${workspaceId}' ORDER BY created_at DESC LIMIT 1`,
  );
  const grantId = grant.rows[0]?.id;
  if (!grantId) throw new Error('Delegated grant fixture was not created');
  await database.exec(`
    INSERT INTO delegated_authorization_codes
      (workspace_id, grant_id, client_id, code_hash, redirect_uri, scopes, code_challenge, expires_at)
      VALUES ('${workspaceId}', '${grantId}', 'open-clips-dev', 'code-same', 'http://127.0.0.1/callback', ARRAY['destinations:read'], repeat('a', 43), now() + interval '5 minutes');
    INSERT INTO delegated_tokens
      (workspace_id, grant_id, access_token_hash, refresh_token_hash, scopes, access_expires_at, refresh_expires_at)
      VALUES ('${workspaceId}', '${grantId}', 'access-same', 'refresh-same', ARRAY['destinations:read'], now() + interval '15 minutes', now() + interval '30 days');
  `);
}
