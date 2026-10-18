import { readFile, readdir } from 'node:fs/promises';

import { drizzle } from 'drizzle-orm/node-postgres';
import Fastify from 'fastify';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import { registerDestinationRoutes } from '../src/modules/credentials/destination.routes.js';
import { listProviderAccountsPage } from '../src/modules/credentials/provider-account.service.js';
import type { ApiKeyService } from '../src/modules/identity/api-key.service.js';

const connectionString = process.env.POSTGRES_DESTINATIONS_TEST_URL;
const run = connectionString ? describe : describe.skip;
const origin = '00000000-0000-4000-8000-000000000101';
const target = '00000000-0000-4000-8000-000000000102';
const user = '00000000-0000-4000-8000-000000000103';
const key = '00000000-0000-4000-8000-000000000104';
const credential = '00000000-0000-4000-8000-000000000105';
const connection = '00000000-0000-4000-8000-000000000106';

run('machine exposed Page discovery on PostgreSQL', () => {
  it('enforces the database principal at the HTTP route and paginates across 100 Pages', async () => {
    const client = new Client({ connectionString });
    const app = Fastify();
    await client.connect();
    try {
      const folder = new URL('../migrations/', import.meta.url);
      const names = (await readdir(folder)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
      for (const name of names) await client.query(await readFile(new URL(name, folder), 'utf8'));
      await client.query(`
        CREATE ROLE publish_relay_app NOLOGIN NOBYPASSRLS;
        GRANT USAGE ON SCHEMA public TO publish_relay_app;
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO publish_relay_app;
        GRANT EXECUTE ON FUNCTION public.list_visible_exposed_facebook_pages_page(uuid, text, uuid, integer)
          TO publish_relay_app;
        INSERT INTO users (id, display_name, email, password_hash)
          VALUES ('${user}', 'Owner', 'owner@example.test', 'hash');
        INSERT INTO workspaces (id, name, slug) VALUES
          ('${origin}', 'Origin', 'origin'), ('${target}', 'Target', 'target');
        INSERT INTO memberships (workspace_id, user_id, role)
          VALUES ('${target}', '${user}', 'owner');
        INSERT INTO api_keys (id, workspace_id, created_by_user_id, label, prefix, secret_hash, capabilities)
          VALUES ('${key}', '${target}', '${user}', 'Machine', 'test', 'hash', ARRAY['destinations:read']);
        INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
          wrapped_key_tag, ciphertext, nonce, tag)
          VALUES ('${credential}', '${origin}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
        INSERT INTO provider_connections (id, workspace_id, provider, credential_id, status)
          VALUES ('${connection}', '${origin}', 'meta', '${credential}', 'active');
        INSERT INTO provider_accounts
          (id, workspace_id, connection_id, provider_account_id, destination_provider, remote_account_id, display_name)
        SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
          '${origin}', '${connection}', 'page-' || g, 'facebook_page', 'page-' || g,
          'Page ' || lpad(g::text, 3, '0') FROM generate_series(200, 301) AS g;
        INSERT INTO provider_account_exposures (workspace_id, provider_account_id)
        SELECT '${target}', ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid
          FROM generate_series(200, 300) AS g;
        SET ROLE publish_relay_app;
      `);
      const db = drizzle(client);
      const principal = {
        id: key,
        workspaceId: target,
        createdByUserId: user,
        workspaceLabel: 'Target',
        prefix: 'test',
        capabilities: ['destinations:read'],
        expiresAt: null,
      };
      const keys = {
        authenticate: () => Promise.resolve(principal),
        requireCapability: () => Promise.resolve(),
      } as unknown as ApiKeyService;
      registerDestinationRoutes(
        app,
        db,
        keys,
        new ApiRateLimiter({
          workspace: 20,
          key: 20,
          mutationWorkspace: 20,
          mutationKey: 20,
          windowMs: 60_000,
        }),
      );
      const headers = { authorization: 'Bearer test', 'x-publish-relay-workspace': target };
      const response = await app.inject({ method: 'GET', url: '/api/v1/destinations', headers });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ data: { items: { id: string }[] } }>();
      expect(body.data.items).toHaveLength(101);
      expect(new Set(body.data.items.map((item) => item.id)).size).toBe(101);
      expect(JSON.stringify(body)).not.toMatch(
        /credential|originWorkspace|adapterDefaults|secret/i,
      );
      const first = await listProviderAccountsPage(db, target, undefined, undefined, undefined, {
        type: 'api-key',
        id: key,
        capability: 'destinations:read',
      });
      expect(first.accounts).toHaveLength(100);
      expect(first.nextCursor).not.toBeNull();
      await client.query('RESET ROLE');
      await client.query(`UPDATE api_keys SET revoked_at = now() WHERE id = '${key}'`);
      await client.query('SET ROLE publish_relay_app');
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/destinations', headers })).json<{
          data: { items: unknown[] };
        }>().data.items,
      ).toEqual([]);
    } finally {
      await app.close();
      await client.end();
    }
  });
});
