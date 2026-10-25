import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  FanvueHttpClient,
  FANVUE_PUBLISHING_SCOPES,
} from '../src/modules/providers/fanvue-http-client.js';
import {
  beginFanvueOauthConnection,
  completeFanvueOauthConnection,
} from '../src/modules/providers/fanvue-oauth.service.js';
import { getFreshFanvueToken } from '../src/modules/providers/fanvue-credential.service.js';
import { connectProvider } from '../src/modules/credentials/provider-connection.service.js';

const connectionString = process.env.POSTGRES_FANVUE_TEST_URL;
const creatorId = 'd6ed1cac-e0cd-4109-bf04-539cb8591838';
const scope = FANVUE_PUBLISHING_SCOPES.join(' ');
const keys = { currentVersion: () => 'v1', getKey: () => Promise.resolve(Buffer.alloc(32, 7)) };

describe.skipIf(!connectionString)('Fanvue tenant OAuth and rotating refresh on PostgreSQL', () => {
  it('persists only a validated creator, isolates state, and serializes a one-use refresh', async () => {
    const pool = new pg.Pool({ connectionString, max: 4 });
    const database = drizzle(pool);
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const userId = randomUUID();
    const token = (refresh: string) => ({
      access_token: `access-${refresh}`,
      refresh_token: refresh,
      token_type: 'bearer',
      expires_in: 3600,
      scope,
    });
    let refreshCalls = 0;
    let deniedScope = false;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((url, options) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (path.endsWith('/users/me'))
        return Promise.resolve(
          new Response(
            JSON.stringify({ uuid: creatorId, displayName: 'Creator', isCreator: true }),
          ),
        );
      const fields = options?.body as URLSearchParams;
      if (fields.get('grant_type') === 'refresh_token') {
        refreshCalls++;
        return Promise.resolve(new Response(JSON.stringify(token('rotated'))));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ...token('original'),
            scope: deniedScope ? 'openid offline_access offline read:self' : scope,
          }),
        ),
      );
    });
    const client = new FanvueHttpClient({
      clientId: 'fixture',
      clientSecret: 'fixture',
      fetch: fetchMock,
    });
    try {
      for (const id of [workspaceId, otherWorkspaceId])
        await pool.query('INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)', [
          id,
          'Fanvue fixture',
          id,
        ]);
      await pool.query(
        'INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)',
        [userId, `${userId}@example.test`, 'fixture', 'Fanvue fixture'],
      );
      await pool.query(
        'INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)',
        [workspaceId, userId, 'owner'],
      );
      const pending = await beginFanvueOauthConnection(database, keys, client, {
        workspaceId,
        userId,
        callbackUrl: 'https://publishrelay.app/api/oauth/fanvue/callback',
        requestId: randomUUID(),
      });
      const state = new URL(pending.authorizationUrl).searchParams.get('state') ?? '';
      const callback = {
        workspaceId,
        userId,
        state,
        code: 'fixture-code',
        requestId: randomUUID(),
      };
      expect(
        await completeFanvueOauthConnection(database, keys, client, {
          ...callback,
          workspaceId: otherWorkspaceId,
        }),
      ).toBeNull();
      const connection = await completeFanvueOauthConnection(
        database,
        keys,
        client,
        callback,
        new Date('2026-01-01'),
      );
      expect(connection?.accounts).toEqual([
        { providerAccountId: creatorId, displayName: 'Creator' },
      ]);
      expect(await completeFanvueOauthConnection(database, keys, client, callback)).toBeNull();
      const before = await pool.query<{ id: string; credential_id: string }>(
        'SELECT id, status, credential_id FROM provider_connections WHERE workspace_id=$1',
        [workspaceId],
      );
      expect(before.rows).toHaveLength(1);
      const owner = before.rows[0];
      if (!owner) throw new Error('Fanvue creator connection was not persisted');
      deniedScope = true;
      const denied = await beginFanvueOauthConnection(database, keys, client, {
        workspaceId,
        userId,
        callbackUrl: 'https://publishrelay.app/api/oauth/fanvue/callback',
        requestId: randomUUID(),
      });
      await expect(
        completeFanvueOauthConnection(database, keys, client, {
          ...callback,
          state: new URL(denied.authorizationUrl).searchParams.get('state') ?? '',
        }),
      ).rejects.toThrow('does not match the requested scopes');
      const retained = await pool.query<{ credential_id: string }>(
        'SELECT credential_id FROM provider_connections WHERE id=$1',
        [owner.id],
      );
      expect(retained.rows[0]?.credential_id).toBe(owner.credential_id);
      deniedScope = false;
      const [first, second] = await Promise.all(
        [1, 2].map(() => getFreshFanvueToken(database, keys, client, { workspaceId, creatorId })),
      );
      expect([first?.refresh_token, second?.refresh_token]).toEqual(['rotated', 'rotated']);
      expect(first?.token_type).toBe('bearer');
      expect(refreshCalls).toBe(1);
      const after = await pool.query<{ version: number }>(
        'SELECT version FROM credentials WHERE id=$1',
        [owner.credential_id],
      );
      expect(after.rows[0]?.version).toBe(2);
      const siblingId = randomUUID();
      await connectProvider(
        database,
        keys,
        {
          discoverAccounts: () =>
            Promise.resolve([{ providerAccountId: siblingId, displayName: 'Other creator' }]),
        },
        {
          workspaceId,
          userId,
          provider: 'fanvue',
          externalSubjectId: siblingId,
          accessToken: JSON.stringify(token('sibling')),
          scopes: [...FANVUE_PUBLISHING_SCOPES],
          accessExpiresAt: new Date(Date.now() + 3_600_000),
          requestId: randomUUID(),
        },
      );
      await pool.query('UPDATE provider_connections SET access_expires_at=$1 WHERE id=$2', [
        new Date('2026-01-01'),
        owner.id,
      ]);
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })),
      );
      await expect(
        getFreshFanvueToken(database, keys, client, { workspaceId, creatorId }),
      ).rejects.toThrow('requires reconnection');
      const failed = await pool.query<{ status: string; last_error_code: string }>(
        'SELECT status, last_error_code FROM provider_connections WHERE id=$1',
        [owner.id],
      );
      expect(failed.rows[0]).toMatchObject({
        status: 'reauth_required',
        last_error_code: 'invalid_grant',
      });
      const account = await pool.query<{ availability: string }>(
        'SELECT availability FROM provider_accounts WHERE connection_id=$1',
        [owner.id],
      );
      expect(account.rows[0]?.availability).toBe('reauth_required');
      const sibling = await pool.query<{ status: string }>(
        'SELECT status FROM provider_connections WHERE workspace_id=$1 AND external_subject_id=$2',
        [workspaceId, siblingId],
      );
      expect(sibling.rows[0]?.status).toBe('active');
      await pool.query(
        'UPDATE provider_connections SET access_expires_at=$1 WHERE workspace_id=$2 AND external_subject_id=$3',
        [new Date('2026-01-01'), workspaceId, siblingId],
      );
      let ambiguousCalls = 0;
      fetchMock.mockImplementation(() => {
        ambiguousCalls++;
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'server_error' }), { status: 503 }),
        );
      });
      await expect(
        getFreshFanvueToken(database, keys, client, { workspaceId, creatorId: siblingId }),
      ).rejects.toThrow('requires reconnection');
      await expect(
        getFreshFanvueToken(database, keys, client, { workspaceId, creatorId: siblingId }),
      ).rejects.toThrow('requires reconnection');
      expect(ambiguousCalls).toBe(1);
      const ambiguous = await pool.query<{ status: string; last_error_code: string }>(
        'SELECT status, last_error_code FROM provider_connections WHERE workspace_id=$1 AND external_subject_id=$2',
        [workspaceId, siblingId],
      );
      expect(ambiguous.rows[0]).toMatchObject({
        status: 'reauth_required',
        last_error_code: 'refresh_uncertain',
      });
    } finally {
      await pool.end();
    }
  });
});
