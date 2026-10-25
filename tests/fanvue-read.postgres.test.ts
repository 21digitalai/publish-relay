import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { connectProvider } from '../src/modules/credentials/provider-connection.service.js';
import {
  FANVUE_PUBLISHING_SCOPES,
  FanvueHttpClient,
} from '../src/modules/providers/fanvue-http-client.js';
import { FanvueReadClient } from '../src/modules/providers/fanvue-read-client.js';
import { FanvueReadService } from '../src/modules/providers/fanvue-read.service.js';

const connectionString = process.env.POSTGRES_FANVUE_TEST_URL;
const keys = { currentVersion: () => 'v1', getKey: () => Promise.resolve(Buffer.alloc(32, 7)) };

describe.skipIf(!connectionString)('Fanvue read account isolation on PostgreSQL', () => {
  it('rejects another workspace and absent chat grant while base publishing reads remain scoped', async () => {
    const pool = new pg.Pool({ connectionString });
    const database = drizzle(pool);
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const userId = randomUUID();
    const creatorId = randomUUID();
    const providerRequest = vi.fn<typeof fetch>();
    const service = new FanvueReadService(
      database,
      keys,
      new FanvueHttpClient({
        clientId: 'fixture',
        clientSecret: 'fixture',
        fetch: providerRequest,
      }),
      new FanvueReadClient(providerRequest),
    );
    try {
      for (const id of [workspaceId, otherWorkspaceId])
        await pool.query('INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)', [
          id,
          'Fanvue read fixture',
          id,
        ]);
      await pool.query(
        'INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)',
        [userId, `${userId}@example.test`, 'fixture', 'Fixture'],
      );
      await pool.query(
        'INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)',
        [workspaceId, userId, 'owner'],
      );
      const token = {
        access_token: 'access',
        refresh_token: 'refresh',
        token_type: 'bearer',
        expires_in: 3600,
        scope: FANVUE_PUBLISHING_SCOPES.join(' '),
      };
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
          accessToken: JSON.stringify(token),
          scopes: FANVUE_PUBLISHING_SCOPES,
          accessExpiresAt: new Date(Date.now() + 3_600_000),
          requestId: randomUUID(),
        },
      );
      const accounts = await pool.query<{ id: string }>(
        'SELECT id FROM provider_accounts WHERE workspace_id=$1 AND destination_provider=$2',
        [workspaceId, 'fanvue'],
      );
      const accountId = accounts.rows[0]?.id;
      if (!accountId) throw new Error('Fanvue fixture account was not persisted');
      await expect(
        service.listChats({ workspaceId: otherWorkspaceId, accountId }),
      ).rejects.toMatchObject({ reason: 'account_not_found' });
      await expect(
        service.listChats({ workspaceId, accountId: randomUUID() }),
      ).rejects.toMatchObject({ reason: 'account_not_found' });
      await expect(service.listChats({ workspaceId, accountId })).rejects.toMatchObject({
        reason: 'scope_missing',
      });
      expect(providerRequest).not.toHaveBeenCalled();
      providerRequest.mockImplementation((url) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).includes(
                '/v1/posts',
              )
                ? { data: [], nextCursor: null }
                : { data: [], pagination: { page: 1, size: 0, hasMore: false } },
            ),
          ),
        ),
      );
      await expect(service.listMedia({ workspaceId, accountId })).resolves.toMatchObject({
        data: [],
      });
      await expect(service.listPosts({ workspaceId, accountId })).resolves.toMatchObject({
        data: [],
      });
      expect(providerRequest).toHaveBeenCalledTimes(2);
      providerRequest.mockClear();
      const readScopes = [...FANVUE_PUBLISHING_SCOPES, 'read:chat'];
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
          accessToken: JSON.stringify({ ...token, scope: readScopes.join(' ') }),
          scopes: readScopes,
          accessExpiresAt: new Date(Date.now() + 3_600_000),
          requestId: randomUUID(),
        },
      );
      await expect(service.listChats({ workspaceId, accountId })).resolves.toMatchObject({
        data: [],
      });
      expect(providerRequest).toHaveBeenCalledTimes(1);
      expect(providerRequest.mock.calls[0]?.[1]?.headers).toMatchObject({
        Authorization: 'Bearer access',
      });
      const siblingCreatorId = randomUUID();
      await connectProvider(
        database,
        keys,
        {
          discoverAccounts: () =>
            Promise.resolve([{ providerAccountId: siblingCreatorId, displayName: 'Sibling' }]),
        },
        {
          workspaceId,
          userId,
          provider: 'fanvue',
          externalSubjectId: siblingCreatorId,
          accessToken: JSON.stringify({
            ...token,
            access_token: 'sibling',
            scope: readScopes.join(' '),
          }),
          scopes: readScopes,
          accessExpiresAt: new Date(Date.now() + 3_600_000),
          requestId: randomUUID(),
        },
      );
      const siblingAccounts = await pool.query<{ id: string }>(
        'SELECT id FROM provider_accounts WHERE workspace_id=$1 AND destination_provider=$2 AND remote_account_id=$3',
        [workspaceId, 'fanvue', siblingCreatorId],
      );
      const siblingAccountId = siblingAccounts.rows[0]?.id;
      if (!siblingAccountId) throw new Error('Sibling Fanvue account was not persisted');
      await service.listMedia({ workspaceId, accountId: siblingAccountId });
      expect(providerRequest.mock.calls[1]?.[1]?.headers).toMatchObject({
        Authorization: 'Bearer sibling',
      });
      await pool.query(
        "UPDATE provider_connections SET status='reauth_required', last_error_code='refresh_pending' WHERE workspace_id=$1 AND external_subject_id=$2",
        [workspaceId, siblingCreatorId],
      );
      await pool.query(
        "UPDATE provider_accounts SET availability='reauth_required' WHERE workspace_id=$1 AND id=$2",
        [workspaceId, siblingAccountId],
      );
      const completeConcurrentRefresh = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          void (async () => {
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              await client.query(
                "UPDATE provider_connections SET status='active', last_error_code=NULL, access_expires_at=now()+interval '1 hour' WHERE workspace_id=$1 AND external_subject_id=$2",
                [workspaceId, siblingCreatorId],
              );
              await client.query(
                "UPDATE provider_accounts SET availability='active' WHERE workspace_id=$1 AND id=$2",
                [workspaceId, siblingAccountId],
              );
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
          })().then(resolve, reject);
        }, 50);
      });
      await expect(
        service.listMedia({ workspaceId, accountId: siblingAccountId }),
      ).resolves.toMatchObject({ data: [] });
      await completeConcurrentRefresh;
      await pool.query(
        "UPDATE provider_connections SET access_expires_at=now()-interval '1 hour' WHERE workspace_id=$1 AND external_subject_id=$2",
        [workspaceId, creatorId],
      );
      providerRequest.mockResolvedValueOnce(
        Response.json({ error: 'invalid_grant' }, { status: 400 }),
      );
      await expect(service.listPosts({ workspaceId, accountId })).rejects.toMatchObject({
        reason: 'reconnect_required',
      });
      await pool.query(
        "UPDATE provider_connections SET access_expires_at=now()-interval '1 hour' WHERE workspace_id=$1 AND external_subject_id=$2",
        [workspaceId, siblingCreatorId],
      );
      providerRequest.mockRejectedValueOnce(new TypeError('private timeout'));
      await expect(
        service.listMedia({ workspaceId, accountId: siblingAccountId }),
      ).rejects.toMatchObject({
        reason: 'reconnect_required',
      });
    } finally {
      await pool.end();
    }
  });
});
