import { readFile, readdir } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import { registerDestinationRoutes } from '../src/modules/credentials/destination.routes.js';
import {
  listProviderAccounts,
  listProviderAccountsPage,
} from '../src/modules/credentials/provider-account.service.js';
import {
  ApiKeyAuthorizationError,
  type ApiKeyService,
} from '../src/modules/identity/api-key.service.js';
import type { DelegatedAuthorizationService } from '../src/modules/delegated-authorization/delegated-authorization.service.js';

const origin = '00000000-0000-4000-8000-000000000101';
const target = '00000000-0000-4000-8000-000000000102';
const other = '00000000-0000-4000-8000-000000000103';
const user = '00000000-0000-4000-8000-000000000104';
const connection = '00000000-0000-4000-8000-000000000105';
const credential = '00000000-0000-4000-8000-000000000106';
const key = '00000000-0000-4000-8000-000000000107';
const grant = '00000000-0000-4000-8000-000000000108';
const accountId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const machine = (type: 'api-key' | 'delegated', id: string) => ({
  type,
  id,
  capability: 'destinations:read' as const,
});

async function seed(database: PGlite): Promise<void> {
  const folder = new URL('../migrations/', import.meta.url);
  const names = (await readdir(folder)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const name of names) await database.exec(await readFile(new URL(name, folder), 'utf8'));
  await database.exec(`
    CREATE ROLE publish_relay_app NOLOGIN NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO publish_relay_app;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO publish_relay_app;
    GRANT EXECUTE ON FUNCTION public.list_visible_exposed_facebook_pages_page(uuid, text, uuid, integer)
      TO publish_relay_app;
    INSERT INTO users (id, display_name, email, password_hash)
      VALUES ('${user}', 'Owner', 'owner@example.test', 'hash');
    INSERT INTO workspaces (id, name, slug) VALUES
      ('${origin}', 'Origin', 'origin'), ('${target}', 'Target', 'target'),
      ('${other}', 'Other', 'other');
    INSERT INTO memberships (workspace_id, user_id, role)
      VALUES ('${target}', '${user}', 'owner');
    INSERT INTO api_keys (id, workspace_id, created_by_user_id, label, prefix, secret_hash, capabilities)
      VALUES ('${key}', '${target}', '${user}', 'Machine', 'machine-test', 'hash',
        ARRAY['destinations:read']);
    INSERT INTO registered_clients (id, display_name, client_type, redirect_uris, allowed_scopes)
      VALUES ('test-client', 'Test', 'public', ARRAY['https://example.test/callback'],
        ARRAY['destinations:read']);
    INSERT INTO delegated_grants (id, workspace_id, user_id, client_id, scopes)
      VALUES ('${grant}', '${target}', '${user}', 'test-client', ARRAY['destinations:read']);
    INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
      wrapped_key_tag, ciphertext, nonce, tag)
      VALUES ('${credential}', '${origin}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
    INSERT INTO provider_connections (id, workspace_id, provider, credential_id, status, scopes)
      VALUES ('${connection}', '${origin}', 'meta', '${credential}', 'active', '["pages_manage_posts"]');
    INSERT INTO provider_accounts
      (id, workspace_id, connection_id, provider_account_id, destination_provider, remote_account_id, display_name)
    SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
      '${origin}', '${connection}', 'page-' || g, 'facebook_page', 'page-' || g,
      'Page ' || lpad(g::text, 3, '0')
    FROM generate_series(200, 203) AS g;
    INSERT INTO provider_account_exposures (workspace_id, provider_account_id)
    SELECT '${target}', ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid
    FROM generate_series(200, 202) AS g;
    SET ROLE publish_relay_app;
  `);
}

describe('machine exposed Page discovery', () => {
  it('admits only current scoped principals, preserves browser discovery and keyset pagination', async () => {
    const database = new PGlite();
    try {
      await seed(database);
      const db = drizzle(database) as unknown as NodePgDatabase;
      const list = (id = key, type: 'api-key' | 'delegated' = 'api-key', workspace = target) =>
        listProviderAccounts(db, workspace, undefined, machine(type, id));
      expect((await list()).map((item) => item.id)).toEqual([
        accountId(200),
        accountId(201),
        accountId(202),
      ]);
      expect((await list(grant, 'delegated')).map((item) => item.id)).toEqual([
        accountId(200),
        accountId(201),
        accountId(202),
      ]);
      expect((await listProviderAccounts(db, target, user)).map((item) => item.id)).toEqual([
        accountId(200),
        accountId(201),
        accountId(202),
      ]);
      expect(await list(key, 'api-key', other)).toEqual([]);
      expect(await list(accountId(999))).toEqual([]);
      await database.exec('RESET ROLE');
      await database.exec(`UPDATE provider_account_exposures SET revoked_at = now()
        WHERE workspace_id = '${target}' AND provider_account_id = '${accountId(202)}';`);
      await database.exec('SET ROLE publish_relay_app');
      expect((await list()).map((item) => item.id)).toEqual([accountId(200), accountId(201)]);
      await database.exec('RESET ROLE');
      await database.exec(`UPDATE provider_accounts SET disconnected_at = now()
        WHERE id = '${accountId(201)}';`);
      await database.exec('SET ROLE publish_relay_app');
      expect((await list()).map((item) => item.id)).toEqual([accountId(200)]);
      await database.exec('RESET ROLE');
      await database.exec(`UPDATE provider_accounts SET disconnected_at = NULL
        WHERE id = '${accountId(201)}';`);
      await database.exec(`UPDATE provider_connections SET status = 'revoking'
        WHERE id = '${connection}';`);
      await database.exec('SET ROLE publish_relay_app');
      expect(await list()).toEqual([]);
      expect((await listProviderAccounts(db, target, user)).map((item) => item.id)).toEqual([
        accountId(200),
        accountId(201),
      ]);
      await database.exec('RESET ROLE');
      await database.exec(`UPDATE provider_connections SET status = 'active'
        WHERE id = '${connection}';`);
      await database.exec(
        `UPDATE api_keys SET capabilities = ARRAY['schedules:read'] WHERE id = '${key}';`,
      );
      await database.exec('SET ROLE publish_relay_app');
      expect(await list()).toEqual([]);
      await database.exec('RESET ROLE');
      await database.exec(
        `UPDATE api_keys SET capabilities = ARRAY['destinations:read'], revoked_at = now() WHERE id = '${key}';`,
      );
      await database.exec('SET ROLE publish_relay_app');
      expect(await list()).toEqual([]);
      await database.exec('RESET ROLE');
      await database.exec(
        `UPDATE api_keys SET revoked_at = NULL, expires_at = now() - interval '1 minute' WHERE id = '${key}';`,
      );
      await database.exec('SET ROLE publish_relay_app');
      expect(await list()).toEqual([]);
      await database.exec('RESET ROLE');
      await database.exec(`UPDATE delegated_grants SET revoked_at = now() WHERE id = '${grant}';`);
      await database.exec('SET ROLE publish_relay_app');
      expect(await list(grant, 'delegated')).toEqual([]);
      await database.exec('RESET ROLE');
      await database.exec(`UPDATE api_keys SET expires_at = NULL WHERE id = '${key}';
        INSERT INTO provider_accounts
          (id, workspace_id, connection_id, provider_account_id, destination_provider, remote_account_id, display_name)
        SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
          '${origin}', '${connection}', 'page-' || g, 'facebook_page', 'page-' || g,
          'Page ' || lpad(g::text, 3, '0') FROM generate_series(300, 400) AS g;
        INSERT INTO provider_account_exposures (workspace_id, provider_account_id)
        SELECT '${target}', ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid
        FROM generate_series(300, 400) AS g;`);
      await database.exec('SET ROLE publish_relay_app');
      const first = await listProviderAccountsPage(
        db,
        target,
        undefined,
        undefined,
        undefined,
        machine('api-key', key),
      );
      expect(first.accounts).toHaveLength(100);
      expect(first.nextCursor).not.toBeNull();
      const second = await listProviderAccountsPage(
        db,
        target,
        undefined,
        first.nextCursor ?? undefined,
        undefined,
        machine('api-key', key),
      );
      expect(second.accounts).toHaveLength(3);
      expect(new Set([...first.accounts, ...second.accounts].map((item) => item.id)).size).toBe(
        103,
      );
    } finally {
      await database.close();
    }
  });

  it('returns only allowlisted summaries on the HTTP route', async () => {
    const database = new PGlite();
    const app = Fastify();
    try {
      await seed(database);
      const principal = {
        id: key,
        workspaceId: target,
        createdByUserId: user,
        workspaceLabel: 'Target',
        prefix: 'machine-test',
        capabilities: ['destinations:read'],
        expiresAt: null,
      };
      const apiKeys = {
        authenticate: (workspace: string, token: string) =>
          Promise.resolve(workspace === target && token === 'test-key' ? principal : null),
        requireCapability: (_principal: typeof principal, capability: string) =>
          capability === 'destinations:read'
            ? Promise.resolve()
            : Promise.reject(new ApiKeyAuthorizationError('Missing capability')),
      } as unknown as ApiKeyService;
      registerDestinationRoutes(
        app,
        drizzle(database) as unknown as NodePgDatabase,
        apiKeys,
        new ApiRateLimiter({
          workspace: 20,
          key: 20,
          mutationWorkspace: 20,
          mutationKey: 20,
          windowMs: 60_000,
        }),
        undefined as DelegatedAuthorizationService | undefined,
      );
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/destinations',
        headers: { authorization: 'Bearer test-key', 'x-publish-relay-workspace': target },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ data: { items: { id: string }[] } }>();
      expect(body.data.items.map((item) => item.id)).toEqual([
        accountId(200),
        accountId(201),
        accountId(202),
      ]);
      expect(JSON.stringify(body)).not.toMatch(
        /credential|originWorkspace|adapterDefaults|secret|remoteAccount|providerAccountId/i,
      );
      expect(Buffer.byteLength(response.body)).toBeLessThan(8000);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/destinations',
            headers: { authorization: 'Bearer test-key', 'x-publish-relay-workspace': other },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
      await database.close();
    }
  });
});
