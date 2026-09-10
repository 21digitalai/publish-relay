import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migrations = [
  new URL('../migrations/0000_identity_tenancy.sql', import.meta.url),
  new URL('../migrations/0028_nosy_dracula.sql', import.meta.url),
  new URL('../migrations/0029_handy_human_fly.sql', import.meta.url),
  new URL('../migrations/0030_delegated_token_resolution.sql', import.meta.url),
];

let database: PGlite;

beforeEach(async () => {
  database = new PGlite();
  for (const migration of migrations) await database.exec(await readFile(migration, 'utf8'));
  await database.exec(`
    CREATE ROLE publish_relay_web NOLOGIN NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO publish_relay_web;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO publish_relay_web;
    GRANT EXECUTE ON FUNCTION public.exchange_delegated_authorization_code(text, text, text, text, text, text, timestamptz, timestamptz, timestamptz) TO publish_relay_web;
    GRANT EXECUTE ON FUNCTION public.resolve_delegated_access_token(text, timestamptz) TO publish_relay_web;
    GRANT EXECUTE ON FUNCTION public.rotate_delegated_refresh_token(text, text, text, timestamptz, timestamptz, timestamptz) TO publish_relay_web;
  `);
});

afterEach(async () => database.close());

describe('delegated authorization persistence', () => {
  it('isolates every grant-owned credential artifact by workspace', async () => {
    await seedGrant('00000000-0000-4000-8000-000000000101');
    await database.exec(`
      SET ROLE publish_relay_web;
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

  it('resolves opaque credentials without weakening tenant table RLS', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000131';
    await seedGrant(workspaceId);
    await database.exec('SET ROLE publish_relay_web;');

    const code = await database.query<{ workspaceId: string }>(`
      SELECT workspace_id AS "workspaceId" FROM exchange_delegated_authorization_code(
        'code-same', 'open-clips-dev', 'http://127.0.0.1/callback', repeat('a', 43),
        'access-issued', 'refresh-issued', now() + interval '15 minutes',
        now() + interval '30 days', now()
      )
    `);
    expect(code.rows[0]?.workspaceId).toBe(workspaceId);
    const replay = await database.query(`
      SELECT * FROM exchange_delegated_authorization_code(
        'code-same', 'open-clips-dev', 'http://127.0.0.1/callback', repeat('a', 43),
        'access-replay', 'refresh-replay', now() + interval '15 minutes',
        now() + interval '30 days', now()
      )
    `);
    expect(replay.rows).toHaveLength(0);

    const access = await database.query<{ workspaceId: string }>(`
      SELECT workspace_id AS "workspaceId"
      FROM resolve_delegated_access_token('access-same', now())
    `);
    expect(access.rows[0]?.workspaceId).toBe(workspaceId);

    const refresh = await database.query<{ workspaceId: string }>(`
      SELECT workspace_id AS "workspaceId" FROM rotate_delegated_refresh_token(
        'refresh-same', 'access-next', 'refresh-next',
        now() + interval '15 minutes', now() + interval '30 days', now()
      )
    `);
    expect(refresh.rows[0]?.workspaceId).toBe(workspaceId);
    const refreshReplay = await database.query(`
      SELECT * FROM rotate_delegated_refresh_token(
        'refresh-same', 'access-third', 'refresh-third',
        now() + interval '15 minutes', now() + interval '30 days', now()
      )
    `);
    expect(refreshReplay.rows).toHaveLength(0);
  });

  it('keeps the code usable after a verifier mismatch or token insert rollback', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000141';
    await seedGrant(workspaceId);
    await database.exec('SET ROLE publish_relay_web;');
    const mismatch = await exchangeCode('wrong-challenge', 'access-wrong', 'refresh-wrong');
    expect(mismatch.rows).toHaveLength(0);

    await expect(exchangeCode('a'.repeat(43), 'access-same', 'refresh-conflict')).rejects.toThrow(
      /unique/,
    );
    const successful = await exchangeCode('a'.repeat(43), 'access-recovered', 'refresh-recovered');
    expect(successful.rows).toHaveLength(1);
  });

  it('allows only one exchange when requests race for the same code', async () => {
    const workspaceId = '00000000-0000-4000-8000-000000000151';
    await seedGrant(workspaceId);
    await database.exec('SET ROLE publish_relay_web;');
    const results = await Promise.all([
      exchangeCode('a'.repeat(43), 'access-race-a', 'refresh-race-a'),
      exchangeCode('a'.repeat(43), 'access-race-b', 'refresh-race-b'),
    ]);
    expect(results.map((result) => result.rows.length).sort()).toEqual([0, 1]);
  });
});

describe('Open Clips development registration migration', () => {
  it('registers the exact loopback callback and bounded delegated scopes', async () => {
    const migration = await readFile(
      new URL('../migrations/0033_open_clips_development_client.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain("'open-clips-dev'");
    expect(migration).toContain("'http://127.0.0.1:43123/callback'");
    expect(migration).toContain("'destinations:read'");
    expect(migration).toContain("'schedules:read'");
    expect(migration).toContain("'schedules:write'");
    expect(migration).toContain("'content:write'");
    expect(migration).toContain("'publishes:retry'");
    expect(migration).not.toContain("'publishes:submit'");
    await database.exec(migration);
    const result = await database.query<{
      displayName: string;
      redirectUris: string[];
      allowedScopes: string[];
    }>(`
      SELECT display_name AS "displayName", redirect_uris AS "redirectUris",
        allowed_scopes AS "allowedScopes"
      FROM registered_clients WHERE id = 'open-clips-dev'
    `);
    expect(result.rows).toEqual([
      {
        displayName: 'Open Clips (development)',
        redirectUris: ['http://127.0.0.1:43123/callback'],
        allowedScopes: [
          'destinations:read',
          'schedules:read',
          'schedules:write',
          'content:write',
          'publishes:retry',
        ],
      },
    ]);
  });
});

function exchangeCode(challenge: string, accessHash: string, refreshHash: string) {
  return database.query(`
    SELECT * FROM exchange_delegated_authorization_code(
      'code-same', 'open-clips-dev', 'http://127.0.0.1/callback', '${challenge}',
      '${accessHash}', '${refreshHash}', now() + interval '15 minutes',
      now() + interval '30 days', now()
    )
  `);
}

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
