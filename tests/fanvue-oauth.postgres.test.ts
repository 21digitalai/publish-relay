import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  FanvueHttpClient,
  FANVUE_PUBLISHING_SCOPES,
  FANVUE_CHAT_READ_SCOPES,
} from '../src/modules/providers/fanvue-http-client.js';
import {
  beginFanvueOauthConnection,
  completeFanvueOauthConnection,
} from '../src/modules/providers/fanvue-oauth.service.js';
import { getFreshFanvueToken } from '../src/modules/providers/fanvue-credential.service.js';
import { connectProvider } from '../src/modules/credentials/provider-connection.service.js';
import { disconnectProviderAccount } from '../src/modules/credentials/provider-account.service.js';

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
    let moduleScope = false;
    let discoveredCreatorId = creatorId;
    let disconnectOnProfileAccountId: string | null = null;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (path.endsWith('/users/me')) {
        if (disconnectOnProfileAccountId) {
          const selectedAccountId = disconnectOnProfileAccountId;
          disconnectOnProfileAccountId = null;
          expect(
            await disconnectProviderAccount(database, {
              workspaceId,
              userId,
              accountId: selectedAccountId,
              requestId: randomUUID(),
            }),
          ).toBe('disconnected');
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ uuid: discoveredCreatorId, displayName: 'Creator', isCreator: true }),
          ),
        );
      }
      const fields = options?.body as URLSearchParams;
      if (fields.get('grant_type') === 'refresh_token') {
        refreshCalls++;
        const pending = await pool.query<{ status: string; last_error_code: string }>(
          'SELECT status, last_error_code FROM provider_connections WHERE workspace_id=$1 AND external_subject_id=$2',
          [workspaceId, creatorId],
        );
        expect(pending.rows[0]).toMatchObject({
          status: 'reauth_required',
          last_error_code: 'refresh_pending',
        });
        return new Response(JSON.stringify(token('rotated')));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ...token('original'),
            scope: deniedScope
              ? 'openid offline_access offline read:self'
              : moduleScope
                ? FANVUE_CHAT_READ_SCOPES.join(' ')
                : scope,
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
      const ownAccount = await pool.query<{ id: string }>(
        'SELECT id FROM provider_accounts WHERE workspace_id=$1 AND remote_account_id=$2',
        [workspaceId, creatorId],
      );
      const accountId = ownAccount.rows[0]?.id;
      if (!accountId) throw new Error('Fanvue account missing before module consent');
      await expect(
        beginFanvueOauthConnection(database, keys, client, {
          workspaceId: otherWorkspaceId,
          userId,
          readChatAccountId: accountId,
          callbackUrl: 'https://publishrelay.app/api/oauth/fanvue/callback',
          requestId: randomUUID(),
        }),
      ).rejects.toThrow();
      const module = await beginFanvueOauthConnection(database, keys, client, {
        workspaceId,
        userId,
        readChatAccountId: accountId,
        callbackUrl: 'https://publishrelay.app/api/oauth/fanvue/callback',
        requestId: randomUUID(),
      });
      expect(new URL(module.authorizationUrl).searchParams.get('scope')).toBe(
        FANVUE_CHAT_READ_SCOPES.join(' '),
      );
      moduleScope = true;
      await completeFanvueOauthConnection(database, keys, client, {
        ...callback,
        state: new URL(module.authorizationUrl).searchParams.get('state') ?? '',
      });
      moduleScope = false;
      const upgraded = await pool.query<{ id: string; scopes: string[] }>(
        `SELECT account.id, connection.scopes
         FROM provider_accounts account JOIN provider_connections connection
           ON connection.id=account.connection_id AND connection.workspace_id=account.workspace_id
         WHERE account.id=$1`,
        [accountId],
      );
      expect(upgraded.rows[0]).toMatchObject({
        id: accountId,
        scopes: [...FANVUE_CHAT_READ_SCOPES],
      });
      const credentialBeforeMismatch = await pool.query<{ credential_id: string }>(
        'SELECT credential_id FROM provider_connections WHERE id=$1',
        [owner.id],
      );
      const mismatch = await beginFanvueOauthConnection(database, keys, client, {
        workspaceId,
        userId,
        readChatAccountId: accountId,
        callbackUrl: 'https://publishrelay.app/api/oauth/fanvue/callback',
        requestId: randomUUID(),
      });
      moduleScope = true;
      discoveredCreatorId = randomUUID();
      await expect(
        completeFanvueOauthConnection(database, keys, client, {
          ...callback,
          state: new URL(mismatch.authorizationUrl).searchParams.get('state') ?? '',
        }),
      ).rejects.toThrow('different creator');
      moduleScope = false;
      discoveredCreatorId = creatorId;
      const credentialAfterMismatch = await pool.query<{ credential_id: string }>(
        'SELECT credential_id FROM provider_connections WHERE id=$1',
        [owner.id],
      );
      expect(credentialAfterMismatch.rows[0]).toEqual(credentialBeforeMismatch.rows[0]);
      const staleConsent = await beginFanvueOauthConnection(database, keys, client, {
        workspaceId,
        userId,
        readChatAccountId: accountId,
        callbackUrl: 'https://publishrelay.app/api/oauth/fanvue/callback',
        requestId: randomUUID(),
      });
      moduleScope = true;
      disconnectOnProfileAccountId = accountId;
      await expect(
        completeFanvueOauthConnection(database, keys, client, {
          ...callback,
          state: new URL(staleConsent.authorizationUrl).searchParams.get('state') ?? '',
        }),
      ).rejects.toThrow('unavailable');
      moduleScope = false;
      const afterDisconnect = await pool.query<{
        credential_id: string;
        status: string;
        disconnected_at: Date;
      }>(
        `SELECT connection.credential_id, connection.status, account.disconnected_at
         FROM provider_connections connection JOIN provider_accounts account
           ON account.connection_id=connection.id AND account.workspace_id=connection.workspace_id
         WHERE account.id=$1`,
        [accountId],
      );
      expect(afterDisconnect.rows[0]).toMatchObject({
        credential_id: credentialBeforeMismatch.rows[0]?.credential_id,
        status: 'disconnected',
      });
      expect(afterDisconnect.rows[0]?.disconnected_at).not.toBeNull();
      await connectProvider(
        database,
        keys,
        {
          discoverAccounts: () =>
            Promise.resolve([{ providerAccountId: creatorId, displayName: 'Creator' }]),
        },
        {
          workspaceId,
          userId,
          provider: 'fanvue',
          externalSubjectId: creatorId,
          accessToken: JSON.stringify(token('reconnected')),
          scopes: [...FANVUE_PUBLISHING_SCOPES],
          accessExpiresAt: new Date('2026-01-01'),
          requestId: randomUUID(),
        },
      );
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
      const faultCreatorId = randomUUID();
      await connectProvider(
        database,
        keys,
        {
          discoverAccounts: () =>
            Promise.resolve([{ providerAccountId: faultCreatorId, displayName: 'Fault creator' }]),
        },
        {
          workspaceId,
          userId,
          provider: 'fanvue',
          externalSubjectId: faultCreatorId,
          accessToken: JSON.stringify(token('fault-original')),
          scopes: [...FANVUE_PUBLISHING_SCOPES],
          accessExpiresAt: new Date('2026-01-01'),
          requestId: randomUUID(),
        },
      );
      const faultConnection = await pool.query<{ credential_id: string }>(
        'SELECT credential_id FROM provider_connections WHERE workspace_id=$1 AND external_subject_id=$2',
        [workspaceId, faultCreatorId],
      );
      const faultCredentialId = faultConnection.rows[0]?.credential_id;
      if (!faultCredentialId) throw new Error('Fault fixture connection was not created');
      const triggerName = `fanvue_fail_${randomUUID().replace(/-/g, '')}`;
      await pool.query(
        `CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'fixture rotation blocked'; END $$`,
      );
      await pool.query(
        `CREATE TRIGGER ${triggerName} BEFORE UPDATE ON credentials
         FOR EACH ROW WHEN (NEW.id = '${faultCredentialId}'::uuid)
         EXECUTE FUNCTION ${triggerName}()`,
      );
      let faultRefreshCalls = 0;
      fetchMock.mockImplementation(() => {
        faultRefreshCalls++;
        return Promise.resolve(new Response(JSON.stringify(token('fault-rotated'))));
      });
      try {
        await expect(
          getFreshFanvueToken(database, keys, client, { workspaceId, creatorId: faultCreatorId }),
        ).rejects.toThrow();
      } finally {
        await pool.query(`DROP TRIGGER ${triggerName} ON credentials`);
        await pool.query(`DROP FUNCTION ${triggerName}()`);
      }
      const quarantined = await pool.query<{ status: string; last_error_code: string }>(
        'SELECT status, last_error_code FROM provider_connections WHERE workspace_id=$1 AND external_subject_id=$2',
        [workspaceId, faultCreatorId],
      );
      expect(quarantined.rows[0]).toMatchObject({
        status: 'reauth_required',
        last_error_code: 'refresh_pending',
      });
      await expect(
        getFreshFanvueToken(database, keys, client, { workspaceId, creatorId: faultCreatorId }),
      ).rejects.toThrow('requires reconnection');
      expect(faultRefreshCalls).toBe(1);
    } finally {
      await pool.end();
    }
  }, 25_000);
});
