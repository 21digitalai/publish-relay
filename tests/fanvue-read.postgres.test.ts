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
import { FanvueCommentService } from '../src/modules/providers/fanvue-comment.service.js';
import type { FanvueCommentClient } from '../src/modules/providers/fanvue-comment-client.js';
import { FanvueMessageService } from '../src/modules/providers/fanvue-message.service.js';
import { FanvueMessageClient } from '../src/modules/providers/fanvue-message-client.js';
import { allowAllActionPolicy } from '../src/modules/policy/action-policy.js';

const connectionString = process.env.POSTGRES_FANVUE_TEST_URL;
const keys = { currentVersion: () => 'v1', getKey: () => Promise.resolve(Buffer.alloc(32, 7)) };

describe.skipIf(!connectionString)('Fanvue read and DM account isolation on PostgreSQL', () => {
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
      const sendMessage = vi.fn();
      const messageService = new FanvueMessageService(
        database,
        service,
        { sendMessage } as unknown as FanvueMessageClient,
        allowAllActionPolicy,
      );
      await expect(
        messageService.sendText({
          workspaceId: otherWorkspaceId,
          accountId,
          fanUuid: randomUUID(),
          clientActionId: randomUUID(),
          text: 'Not authorized',
          actor: { type: 'user', id: userId },
        }),
      ).rejects.toMatchObject({ reason: 'account_not_found' });
      expect(sendMessage).not.toHaveBeenCalled();
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
      const postUuid = randomUUID();
      await expect(
        service.getOwnedPostForComment({ workspaceId: otherWorkspaceId, accountId, postUuid }),
      ).rejects.toMatchObject({ reason: 'account_not_found' });
      const createComment = vi.fn();
      const commentService = new FanvueCommentService(
        database,
        service,
        { createComment } as unknown as FanvueCommentClient,
        allowAllActionPolicy,
      );
      await expect(
        commentService.send({
          workspaceId: otherWorkspaceId,
          accountId,
          postUuid,
          clientActionId: randomUUID(),
          text: 'Not authorized',
          actor: { type: 'user', id: userId },
        }),
      ).rejects.toMatchObject({ reason: 'account_not_found' });
      expect(createComment).not.toHaveBeenCalled();
      providerRequest.mockResolvedValueOnce(
        Response.json({
          uuid: postUuid,
          createdAt: new Date().toISOString(),
          publishedAt: new Date().toISOString(),
          text: 'fixture',
          audience: 'subscribers',
          price: null,
          mediaUuids: [],
          mediaPreviewUuid: null,
        }),
      );
      await expect(
        service.getOwnedPostForComment({ workspaceId, accountId, postUuid }),
      ).resolves.toMatchObject({ accessToken: 'access', post: { uuid: postUuid } });
      expect(providerRequest).toHaveBeenCalledTimes(3);
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
      const sendScopes = [...readScopes, 'write:chat'];
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
          accessToken: JSON.stringify({ ...token, scope: sendScopes.join(' ') }),
          scopes: sendScopes,
          accessExpiresAt: new Date(Date.now() + 3_600_000),
          requestId: randomUUID(),
        },
      );
      const fanUuid = randomUUID();
      const mediaUuid = randomUUID();
      const messageUuid = randomUUID();
      providerRequest.mockClear();
      providerRequest.mockImplementation((url, options) => {
        const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        if (path.endsWith(`/chats/${fanUuid}/message`))
          return Promise.resolve(Response.json({ messageUuid }, { status: 201 }));
        if (path.includes(`/chats/${fanUuid}/messages`))
          return Promise.resolve(
            Response.json({
              data: [
                {
                  uuid: randomUUID(),
                  text: 'Prior chat',
                  sentAt: new Date().toISOString(),
                  sender: { uuid: fanUuid },
                  recipient: { uuid: creatorId },
                  type: 'text',
                },
              ],
              pagination: { page: 1, size: 1, hasMore: false },
            }),
          );
        if (path.endsWith(`/media/${mediaUuid}`)) {
          if ((options?.headers as Record<string, string>).Authorization !== 'Bearer access')
            return Promise.resolve(Response.json({ error: 'wrong account' }, { status: 404 }));
          return Promise.resolve(Response.json({ uuid: mediaUuid, status: 'ready' }));
        }
        throw new Error(`Unexpected Fanvue fixture request: ${path}`);
      });
      const accountBackedSend = new FanvueMessageService(
        database,
        service,
        new FanvueMessageClient(providerRequest),
        allowAllActionPolicy,
      );
      const sendInput = {
        workspaceId,
        accountId,
        fanUuid,
        clientActionId: randomUUID(),
        mediaUuids: [mediaUuid],
        price: 300,
        mediaPreviewUuid: mediaUuid,
        actor: { type: 'user' as const, id: userId },
      };
      await expect(
        accountBackedSend.sendMessage({ ...sendInput, workspaceId: otherWorkspaceId }),
      ).rejects.toMatchObject({ reason: 'account_not_found' });
      expect(providerRequest).not.toHaveBeenCalled();
      await expect(accountBackedSend.sendMessage(sendInput)).resolves.toEqual({
        state: 'confirmed',
        messageUuid,
      });
      await expect(accountBackedSend.sendMessage(sendInput)).resolves.toEqual({
        state: 'confirmed',
        messageUuid,
      });
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
            scope: sendScopes.join(' '),
          }),
          scopes: sendScopes,
          accessExpiresAt: new Date(Date.now() + 3_600_000),
          requestId: randomUUID(),
        },
      );
      await expect(
        accountBackedSend.sendMessage({
          ...sendInput,
          accountId: siblingAccountId,
          clientActionId: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        providerRequest.mock.calls.filter((call) => {
          const url = call[0];
          const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
          return path.endsWith('/message');
        }),
      ).toHaveLength(1);
      providerRequest.mockImplementation(() =>
        Promise.resolve(
          Response.json({ data: [], pagination: { page: 1, size: 0, hasMore: false } }),
        ),
      );
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
