import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { registerApiKeyRoutes } from '../src/modules/identity/api-key.routes.js';
import type { ApiKeyService } from '../src/modules/identity/api-key.service.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () =>
  Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        ),
    ),
  ),
);

async function fixture(
  status: number,
  body: unknown,
  workspace = '00000000-0000-4000-8000-000000000201',
  paths?: string[],
) {
  const server = createServer((request, response) => {
    if (request.url !== '/api/v1/account') paths?.push(request.url ?? '');
    if (request.headers['x-publish-relay-workspace'] !== workspace) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          success: false,
          error: { code: 'authentication_required', message: 'Workspace header required' },
        }),
      );
      return;
    }
    const payload =
      request.url === '/api/v1/account'
        ? {
            success: true,
            data: {
              id: 'key-1',
              workspaceId: workspace,
              workspaceLabel: 'Atlas',
              prefix: 'pr_public',
              capabilities: ['schedules:read'],
              expiresAt: null,
            },
            meta: { requestId: 'preflight' },
          }
        : body;
    response.writeHead(request.url === '/api/v1/account' ? 200 : status, {
      'content-type': 'application/json',
    });
    response.end(JSON.stringify(payload));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return `http://127.0.0.1:${String(address.port)}`;
}

async function cli(
  args: string[],
  env: Record<string, string> = {},
  entrypoint = 'src/entrypoints/cli.ts',
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entrypoint, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PUBLISH_RELAY_WORKSPACE: '00000000-0000-4000-8000-000000000201',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (value) => {
      stdout += String(value);
    });
    child.stderr.on('data', (value) => {
      stderr += String(value);
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe('Publish Relay CLI', () => {
  it.each(['src/entrypoints/cli.ts', 'src/modules/api/assets/publish-relay-cli.js'])(
    'schedules a one-bubble Page DM group through %s',
    async (entrypoint) => {
      const accountId = '00000000-0000-4000-8000-000000000402';
      const clientActionId = '00000000-0000-4000-8000-000000000403';
      const paths: string[] = [];
      const baseUrl = await fixture(
        202,
        {
          data: { id: clientActionId, status: 'pending', dueAt: '2026-11-11T02:00:00.000Z' },
          error: null,
        },
        undefined,
        paths,
      );
      const folder = await mkdtemp(join(tmpdir(), 'relay-dm-one-bubble-'));
      const bodyFile = join(folder, 'group.json');
      await writeFile(
        bodyFile,
        JSON.stringify({
          clientActionId,
          texts: ['Brief reply'],
          expectedLatestInboundMessageId: 'mid-1',
        }),
      );
      const result = await cli(
        [
          'facebook-dms',
          'group-schedule',
          accountId,
          '--conversation-id',
          't_123',
          '--body-file',
          bodyFile,
          '--idempotency-key',
          clientActionId,
          '--base-url',
          baseUrl,
        ],
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      expect(result.code).toBe(0);
      expect(paths).toEqual([
        `/api/v1/destinations/${accountId}/facebook-conversations/t_123/scheduled-groups`,
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({ data: { status: 'pending' } });
    },
  );

  it.each(['src/entrypoints/cli.ts', 'src/modules/api/assets/publish-relay-cli.js'])(
    'batches Page memory and upserts a compact patch in %s',
    async (entrypoint) => {
      const accountId = '00000000-0000-4000-8000-000000000402';
      const paths: string[] = [];
      const baseUrl = await fixture(
        200,
        {
          data: {
            records: [
              {
                conversationId: 't_1',
                facts: ['One fact'],
                terminal: false,
                providerToken: 'private',
              },
            ],
          },
          error: null,
        },
        undefined,
        paths,
      );
      const folder = await mkdtemp(join(tmpdir(), 'relay-dm-memory-'));
      const batchFile = join(folder, 'batch.json');
      await writeFile(batchFile, JSON.stringify({ conversationIds: ['t_1'], terminal: 'exclude' }));
      const get = await cli(
        [
          'facebook-dms',
          'memory-get-many',
          accountId,
          '--body-file',
          batchFile,
          '--base-url',
          baseUrl,
        ],
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      expect(get.code).toBe(0);
      expect(paths).toEqual([
        `/api/v1/destinations/${accountId}/facebook-conversations/memory/get-many`,
      ]);
      expect(JSON.parse(get.stdout)).toMatchObject({
        data: { records: [{ facts: ['One fact'], providerToken: '[REDACTED]' }] },
      });
      const patchFile = join(folder, 'patch.json');
      await writeFile(patchFile, JSON.stringify({ facts: ['Updated fact'] }));
      const upsert = await cli(
        [
          'facebook-dms',
          'memory-upsert',
          accountId,
          '--conversation-id',
          't_1',
          '--body-file',
          patchFile,
          '--base-url',
          baseUrl,
        ],
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      expect(upsert.code).toBe(0);
      expect(paths[1]).toBe(`/api/v1/destinations/${accountId}/facebook-conversations/t_1/memory`);
    },
  );
  it.each(['src/entrypoints/cli.ts', 'src/modules/api/assets/publish-relay-cli.js'])(
    'stages a Page proposal with an exact action key and redacted receipt in %s',
    async (entrypoint) => {
      const actionId = '00000000-0000-4000-8000-000000000403';
      const paths: string[] = [];
      const baseUrl = await fixture(
        201,
        {
          data: {
            id: '00000000-0000-4000-8000-000000000404',
            status: 'pending',
            content: { text: 'Private draft' },
            credentialId: 'private',
          },
          error: null,
        },
        undefined,
        paths,
      );
      const folder = await mkdtemp(join(tmpdir(), 'relay-proposal-'));
      const bodyFile = join(folder, 'proposal.json');
      await writeFile(
        bodyFile,
        JSON.stringify({
          accountId: '00000000-0000-4000-8000-000000000402',
          clientActionId: actionId,
          provider: 'facebook_page',
          kind: 'comment',
          targetId: '900_2',
          sourceContext: { postId: '900_1', text: 'Visitor comment' },
          content: { text: 'Private draft' },
        }),
      );
      const args = [
        'proposals',
        'create',
        '--body-file',
        bodyFile,
        '--idempotency-key',
        actionId,
        '--base-url',
        baseUrl,
      ];
      const result = await cli(args, { PUBLISH_RELAY_API_KEY: 'test-key' }, entrypoint);
      expect(result.code).toBe(0);
      expect(paths).toEqual(['/api/v1/engagement-proposals']);
      expect(JSON.parse(result.stdout)).toMatchObject({
        data: {
          status: 'pending',
          content: '[REDACTED]',
          credentialId: '[REDACTED]',
        },
      });
      const wrongArgs = [...args];
      wrongArgs[5] = '00000000-0000-4000-8000-000000000405';
      const wrongKey = await cli(wrongArgs, { PUBLISH_RELAY_API_KEY: 'test-key' }, entrypoint);
      expect(wrongKey.code).toBe(2);
      expect(paths).toHaveLength(1);
    },
  );
  it.each(['src/entrypoints/cli.ts', 'src/modules/api/assets/publish-relay-cli.js'])(
    'reports the published manifest CLI version in %s',
    async (entrypoint) => {
      const result = await cli(['version'], {}, entrypoint);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ data: { version: '1.8.10' } });
    },
  );

  it.each(['src/entrypoints/cli.ts', 'src/modules/api/assets/publish-relay-cli.js'])(
    'reads a recorded proposal status without exposing draft data in %s',
    async (entrypoint) => {
      const proposalId = '00000000-0000-4000-8000-000000000404';
      const paths: string[] = [];
      const baseUrl = await fixture(
        200,
        {
          data: {
            id: proposalId,
            status: 'expired',
            plannedDueAt: '2026-11-05T14:05:00.000Z',
            content: { text: 'Private draft' },
          },
          error: null,
        },
        undefined,
        paths,
      );
      const result = await cli(
        ['proposals', 'status', proposalId, '--base-url', baseUrl],
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      expect(result.code).toBe(0);
      expect(paths).toEqual([`/api/v1/engagement-proposals/${proposalId}/status`]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        data: {
          id: proposalId,
          status: 'expired',
          plannedDueAt: '2026-11-05T14:05:00.000Z',
          content: '[REDACTED]',
        },
      });
    },
  );

  it.each(['src/entrypoints/cli.ts', 'src/modules/api/assets/publish-relay-cli.js'])(
    'reads selected Page posts and comments without leaking provider fields in %s',
    async (entrypoint) => {
      const accountId = '00000000-0000-4000-8000-000000000002';
      const paths: string[] = [];
      const baseUrl = await fixture(
        200,
        {
          success: true,
          data: {
            posts: [
              {
                id: '123_456',
                text: 'Page post',
                createdAt: '2026-10-26T12:00:00Z',
                permalink: null,
                accessToken: 'private',
              },
            ],
            comments: [
              {
                id: '456_789',
                text: 'Visitor reply',
                createdAt: '2026-10-26T12:10:00Z',
                replyCount: null,
                likeCount: 2,
                providerProfile: { email: 'private@example.test' },
              },
            ],
            nextCursor: 'next-cursor',
          },
        },
        '00000000-0000-4000-8000-000000000201',
        paths,
      );
      const shared = ['--limit', '5', '--after', 'prior-cursor', '--base-url', baseUrl];
      const posts = await cli(
        ['facebook-comments', 'posts', accountId, ...shared],
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      const comments = await cli(
        ['facebook-comments', 'list', accountId, '--post-id', '123_456', ...shared],
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      expect(posts.code).toBe(0);
      expect(comments.code).toBe(0);
      expect(paths).toEqual([
        `/api/v1/destinations/${accountId}/facebook-posts?limit=5&after=prior-cursor`,
        `/api/v1/destinations/${accountId}/facebook-posts/123_456/comments?limit=5&after=prior-cursor`,
      ]);
      expect((JSON.parse(posts.stdout) as { data: unknown }).data).toMatchObject({
        posts: [{ text: 'Page post', accessToken: '[REDACTED]' }],
        nextCursor: 'next-cursor',
      });
      expect((JSON.parse(comments.stdout) as { data: unknown }).data).toMatchObject({
        comments: [{ text: 'Visitor reply', likeCount: 2, providerProfile: '[REDACTED]' }],
        nextCursor: 'next-cursor',
      });
      const invalid = await cli(
        ['facebook-comments', 'list', accountId, '--post-id', '../foreign', '--base-url', baseUrl],
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      expect(invalid.code).toBe(2);
      expect(paths).toHaveLength(2);
    },
  );

  it.each(['src/entrypoints/cli.ts', 'src/modules/api/assets/publish-relay-cli.js'])(
    'sends one Page-scoped comment reply with exact action key and bounded receipt in %s',
    async (entrypoint) => {
      const accountId = '00000000-0000-4000-8000-000000000002';
      const actionId = '00000000-0000-4000-8000-000000000003';
      const paths: string[] = [];
      const baseUrl = await fixture(
        201,
        {
          success: true,
          data: { state: 'confirmed', commentId: '123_456_900', accessToken: 'private' },
        },
        undefined,
        paths,
      );
      const folder = await mkdtemp(join(tmpdir(), 'relay-comment-'));
      const bodyFile = join(folder, 'reply.json');
      await writeFile(bodyFile, JSON.stringify({ clientActionId: actionId, text: 'Thanks' }));
      const args = [
        'facebook-comments',
        'reply',
        accountId,
        '--post-id',
        '123_456',
        '--comment-id',
        '123_456_789',
        '--body-file',
        bodyFile,
        '--idempotency-key',
        actionId,
        '--base-url',
        baseUrl,
      ];
      const sent = await cli(args, { PUBLISH_RELAY_API_KEY: 'test-key' }, entrypoint);
      expect(sent.code).toBe(0);
      expect(paths).toEqual([
        `/api/v1/destinations/${accountId}/facebook-posts/123_456/comments/123_456_789/replies`,
      ]);
      expect(JSON.parse(sent.stdout)).toMatchObject({
        data: { state: 'confirmed', commentId: '123_456_900', accessToken: '[REDACTED]' },
      });
      const invalid = await cli(
        [
          ...args.slice(0, -4),
          '--idempotency-key',
          '00000000-0000-4000-8000-000000000005',
          '--base-url',
          baseUrl,
        ],
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      expect(invalid.code).toBe(2);
      expect(paths).toHaveLength(1);
    },
  );

  it.each(['src/entrypoints/cli.ts', 'src/modules/api/assets/publish-relay-cli.js'])(
    'rejects a workspace label before making an authenticated request in %s',
    async (entrypoint) => {
      const result = await cli(
        [
          'account',
          'current',
          '--base-url',
          'http://127.0.0.1:1',
          '--require-workspace',
          '21digital',
        ],
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('workspace UUID is required');
    },
  );

  it.each(['src/entrypoints/cli.ts', 'src/modules/api/assets/publish-relay-cli.js'])(
    'discovers and reads Page conversations with bounded output in %s',
    async (entrypoint) => {
      const accountId = '00000000-0000-4000-8000-000000000002';
      const paths: string[] = [];
      const baseUrl = await fixture(
        200,
        {
          success: true,
          data: {
            conversations: [
              { id: 't_blocked', displayName: 'Alexandra', noGo: true, providerToken: 'private' },
              {
                id: 't_allowed',
                displayName: 'Maya',
                noGo: false,
                link: 'https://www.facebook.com/messages/t/123',
                providerToken: 'private',
              },
            ],
            messages: [
              {
                id: 'm_1',
                text: 'Hello',
                senderId: 'sender_1',
                contentKind: 'attachment',
                contentSubtype: 'image',
                createdAt: '2026-10-26T12:00:00Z',
                providerToken: 'private',
              },
            ],
            participantId: 'sender_1',
            displayName: 'Birkan Reyhan',
            link: 'https://www.facebook.com/messages/t/123',
            providerProfile: { email: 'private@example.test' },
            nextCursor: 'cursor-2',
          },
        },
        '00000000-0000-4000-8000-000000000201',
        paths,
      );
      const list = await cli(
        [
          'facebook-dms',
          'list',
          accountId,
          '--limit',
          '5',
          '--after',
          'cursor-1',
          '--base-url',
          baseUrl,
        ],
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      expect(list.code).toBe(0);
      expect(paths[0]).toBe(
        `/api/v1/destinations/${accountId}/facebook-conversations?limit=5&after=cursor-1`,
      );
      expect((JSON.parse(list.stdout) as { data: unknown }).data).toMatchObject({
        displayName: 'Birkan Reyhan',
        conversations: [
          { noGo: true, providerToken: '[REDACTED]' },
          {
            noGo: false,
            link: 'https://www.facebook.com/messages/t/123',
            providerToken: '[REDACTED]',
          },
        ],
        providerProfile: '[REDACTED]',
      });
      const result = await cli(
        [
          'facebook-dms',
          'messages',
          accountId,
          '--conversation-id',
          't_123',
          '--limit',
          '5',
          '--after',
          'cursor-1',
          '--base-url',
          baseUrl,
        ],
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      expect(result.code).toBe(0);
      expect(paths.slice(1)).toEqual([
        `/api/v1/destinations/${accountId}/facebook-conversations/t_123/messages?limit=5&after=cursor-1`,
      ]);
      expect((JSON.parse(result.stdout) as { data: unknown }).data).toMatchObject({
        displayName: 'Birkan Reyhan',
        link: 'https://www.facebook.com/messages/t/123',
        messages: [
          {
            text: 'Hello',
            contentKind: 'attachment',
            contentSubtype: 'image',
            providerToken: '[REDACTED]',
          },
        ],
        nextCursor: 'cursor-2',
      });
    },
  );

  it.each(['src/entrypoints/cli.ts', 'src/modules/api/assets/publish-relay-cli.js'])(
    'sends through the canonical Page route with matched action ID in %s',
    async (entrypoint) => {
      const accountId = '00000000-0000-4000-8000-000000000002';
      const actionId = '00000000-0000-4000-8000-000000000003';
      const paths: string[] = [];
      const baseUrl = await fixture(
        202,
        { success: true, data: { state: 'unknown', secret: 'private' } },
        '00000000-0000-4000-8000-000000000201',
        paths,
      );
      const directory = await mkdtemp(join(tmpdir(), 'relay-facebook-dm-'));
      const bodyFile = join(directory, 'reply.json');
      await writeFile(bodyFile, JSON.stringify({ clientActionId: actionId, text: 'Hello' }));
      const args = [
        'facebook-dms',
        'send',
        accountId,
        '--conversation-id',
        't_123',
        '--body-file',
        bodyFile,
        '--idempotency-key',
        actionId,
        '--base-url',
        baseUrl,
      ];
      const result = await cli(args, { PUBLISH_RELAY_API_KEY: 'test-key' }, entrypoint);
      expect(result.code).toBe(0);
      expect(paths).toEqual([
        `/api/v1/destinations/${accountId}/facebook-conversations/t_123/messages`,
      ]);
      expect((JSON.parse(result.stdout) as { data: unknown }).data).toEqual({
        state: 'unknown',
        secret: '[REDACTED]',
      });
      const rejected = await cli(
        args.map((value) => (value === actionId ? '00000000-0000-4000-8000-000000000004' : value)),
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      expect(rejected.code).toBe(2);
      expect(paths).toHaveLength(1);
    },
  );
  it.each(['src/entrypoints/cli.ts', 'src/modules/api/assets/publish-relay-cli.js'])(
    'schedules and cancels a Page DM through the existing intent routes in %s',
    async (entrypoint) => {
      const accountId = '00000000-0000-4000-8000-000000000002';
      const actionId = '00000000-0000-4000-8000-000000000003';
      const intentId = '00000000-0000-4000-8000-000000000006';
      const paths: string[] = [];
      const baseUrl = await fixture(
        202,
        {
          success: true,
          data: {
            id: intentId,
            status: 'pending',
            dueAt: '2026-11-08T21:30:00Z',
            providerToken: 'private',
          },
        },
        '00000000-0000-4000-8000-000000000201',
        paths,
      );
      const directory = await mkdtemp(join(tmpdir(), 'relay-facebook-dm-schedule-'));
      const bodyFile = join(directory, 'schedule.json');
      await writeFile(
        bodyFile,
        JSON.stringify({
          clientActionId: actionId,
          text: 'Hello',
          schedule: { earliestDelaySeconds: 1800, latestDelaySeconds: 2100 },
        }),
      );
      const baseArgs = [
        accountId,
        '--conversation-id',
        't_123',
        '--body-file',
        bodyFile,
        '--idempotency-key',
        actionId,
        '--base-url',
        baseUrl,
      ];
      const scheduled = await cli(
        ['facebook-dms', 'schedule', ...baseArgs],
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      expect(scheduled.code).toBe(0);
      expect(paths).toEqual([
        `/api/v1/destinations/${accountId}/facebook-conversations/t_123/messages`,
      ]);
      expect((JSON.parse(scheduled.stdout) as { data: unknown }).data).toEqual({
        id: intentId,
        status: 'pending',
        dueAt: '2026-11-08T21:30:00Z',
        providerToken: '[REDACTED]',
      });
      const direct = await cli(
        ['facebook-dms', 'send', ...baseArgs],
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      expect(direct.code).toBe(2);
      expect(paths).toHaveLength(1);
      await writeFile(bodyFile, JSON.stringify({ clientActionId: actionId, text: 'Hello' }));
      const missingSchedule = await cli(
        ['facebook-dms', 'schedule', ...baseArgs],
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      expect(missingSchedule.code).toBe(2);
      expect(paths).toHaveLength(1);
      const cancelled = await cli(
        [
          'facebook-dms',
          'cancel',
          accountId,
          '--conversation-id',
          't_123',
          '--intent-id',
          intentId,
          '--base-url',
          baseUrl,
        ],
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      expect(cancelled.code).toBe(0);
      expect(paths[1]).toBe(
        `/api/v1/destinations/${accountId}/facebook-conversations/t_123/scheduled/${intentId}`,
      );
      const invalid = await cli(
        [
          'facebook-dms',
          'cancel',
          accountId,
          '--conversation-id',
          't_123',
          '--intent-id',
          'bad',
          '--base-url',
          baseUrl,
        ],
        { PUBLISH_RELAY_API_KEY: 'test-key' },
        entrypoint,
      );
      expect(invalid.code).toBe(2);
      expect(paths).toHaveLength(2);
    },
  );
  it('routes a selected Fanvue chat creation with workspace preflight and bounded output', async () => {
    const accountId = '00000000-0000-4000-8000-000000000002';
    const fanUuid = '00000000-0000-4000-8000-000000000003';
    const clientActionId = '00000000-0000-4000-8000-000000000004';
    const paths: string[] = [];
    const baseUrl = await fixture(
      201,
      {
        success: true,
        data: { state: 'confirmed', fanUuid, accessToken: 'private' },
      },
      '00000000-0000-4000-8000-000000000201',
      paths,
    );
    const directory = await mkdtemp(join(tmpdir(), 'relay-chat-'));
    const bodyFile = join(directory, 'create-chat.json');
    await writeFile(bodyFile, JSON.stringify({ fanUuid, clientActionId }));
    const result = await cli(
      [
        'fanvue',
        'create-chat',
        accountId,
        '--base-url',
        baseUrl,
        '--body-file',
        bodyFile,
        '--idempotency-key',
        clientActionId,
      ],
      { PUBLISH_RELAY_API_KEY: 'test-key' },
    );
    expect(result.code).toBe(0);
    expect(paths).toEqual([`/api/v1/fanvue/accounts/${accountId}/chats`]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { state: 'confirmed', fanUuid, accessToken: '[REDACTED]' },
    });
  });
  it('routes Fanvue guarded group schedule, status and cancel commands', async () => {
    const accountId = '00000000-0000-4000-8000-000000000002';
    const fanUuid = '00000000-0000-4000-8000-000000000003';
    const actionId = '00000000-0000-4000-8000-000000000004';
    const paths: string[] = [];
    const baseUrl = await fixture(
      200,
      {
        success: true,
        data: { clientActionId: actionId, status: 'pending', dueAt: '2026-11-11T10:30:00Z' },
      },
      '00000000-0000-4000-8000-000000000201',
      paths,
    );
    const directory = await mkdtemp(join(tmpdir(), 'relay-fanvue-group-'));
    const bodyFile = join(directory, 'group.json');
    await writeFile(
      bodyFile,
      JSON.stringify({
        clientActionId: actionId,
        bubbles: ['One', 'Two'],
        expectedLatestInboundMessageUuid: '00000000-0000-4000-8000-000000000005',
        expectedLatestInboundAt: '2026-11-11T10:00:00Z',
        earliestAt: '2026-11-11T10:01:00Z',
        latestAt: '2026-11-11T12:00:00Z',
      }),
    );
    const common = [accountId, '--fan-uuid', fanUuid, '--root-id', actionId, '--base-url', baseUrl];
    expect(
      (
        await cli(
          [
            'fanvue-dms',
            'group-schedule',
            ...common,
            '--body-file',
            bodyFile,
            '--idempotency-key',
            actionId,
          ],
          { PUBLISH_RELAY_API_KEY: 'test-key' },
        )
      ).code,
    ).toBe(0);
    expect(
      (await cli(['fanvue-dms', 'group-status', ...common], { PUBLISH_RELAY_API_KEY: 'test-key' }))
        .code,
    ).toBe(0);
    expect(
      (await cli(['fanvue-dms', 'group-cancel', ...common], { PUBLISH_RELAY_API_KEY: 'test-key' }))
        .code,
    ).toBe(0);
    expect(paths).toEqual([
      `/api/v1/fanvue/accounts/${accountId}/chats/${fanUuid}/messages/scheduled-groups`,
      `/api/v1/fanvue/accounts/${accountId}/chats/${fanUuid}/messages/scheduled-groups/${actionId}`,
      `/api/v1/fanvue/accounts/${accountId}/chats/${fanUuid}/messages/scheduled-groups/${actionId}`,
    ]);
  });
  it('routes bounded Fanvue DM candidate and checkpoint discovery commands', async () => {
    const accountId = '00000000-0000-4000-8000-000000000002';
    const fanUuid = '00000000-0000-4000-8000-000000000003';
    const paths: string[] = [];
    const baseUrl = await fixture(
      200,
      { success: true, data: [] },
      '00000000-0000-4000-8000-000000000201',
      paths,
    );
    const common = [accountId, '--base-url', baseUrl];
    expect(
      (
        await cli(['fanvue-dms', 'candidates', ...common, '--size', '25'], {
          PUBLISH_RELAY_API_KEY: 'test-key',
        })
      ).code,
    ).toBe(0);
    expect(
      (
        await cli(['fanvue-dms', 'checkpoints', ...common, '--fan-uuid', fanUuid], {
          PUBLISH_RELAY_API_KEY: 'test-key',
        })
      ).code,
    ).toBe(0);
    expect(paths).toEqual([
      `/api/v1/fanvue/accounts/${accountId}/dm-conversations/due?size=25`,
      `/api/v1/fanvue/accounts/${accountId}/chats/${fanUuid}/checkpoints`,
    ]);
  });
  it('routes Fanvue vault folder reads with pagination and encoded folder names', async () => {
    const accountId = '00000000-0000-4000-8000-000000000002';
    const mediaUuid = '00000000-0000-4000-8000-000000000003';
    const paths: string[] = [];
    const baseUrl = await fixture(
      200,
      {
        success: true,
        data: {
          data: [
            {
              uuid: mediaUuid,
              status: 'ready',
              name: 'Approved',
              mediaType: 'image',
              url: 'private',
            },
          ],
          pagination: { page: 2, size: 1, hasMore: false },
        },
      },
      '00000000-0000-4000-8000-000000000201',
      paths,
    );
    const result = await cli(
      [
        'fanvue',
        'folder-media',
        accountId,
        '--folder-name',
        'DMs / Български',
        '--page',
        '2',
        '--size',
        '50',
        '--base-url',
        baseUrl,
      ],
      { PUBLISH_RELAY_API_KEY: 'test-key' },
    );
    expect(result.code).toBe(0);
    expect(paths).toEqual([
      `/api/v1/fanvue/accounts/${accountId}/vault/folders/DMs%20%2F%20%D0%91%D1%8A%D0%BB%D0%B3%D0%B0%D1%80%D1%81%D0%BA%D0%B8/media?page=2&size=50`,
    ]);
    const output = JSON.parse(result.stdout) as { data: { data: unknown[] } };
    expect(output.data.data[0]).toEqual({
      uuid: mediaUuid,
      status: 'ready',
      name: 'Approved',
      mediaType: 'image',
      url: '[REDACTED]',
    });
  });
  it('routes the priced Fanvue vault catalog without exposing provider URLs', async () => {
    const accountId = '00000000-0000-4000-8000-000000000002';
    const mediaUuid = '00000000-0000-4000-8000-000000000003';
    const paths: string[] = [];
    const baseUrl = await fixture(
      200,
      {
        success: true,
        data: {
          data: [
            {
              uuid: mediaUuid,
              status: 'ready',
              name: 'Approved',
              mediaType: 'image',
              manualPriceCents: 450,
              priceVersion: 2,
              url: 'private',
            },
          ],
          pagination: { page: 2, size: 1, hasMore: false },
        },
      },
      '00000000-0000-4000-8000-000000000201',
      paths,
    );
    const result = await cli(
      [
        'fanvue',
        'vault-catalog',
        accountId,
        '--folder-name',
        'Paid / Български',
        '--page',
        '2',
        '--size',
        '50',
        '--base-url',
        baseUrl,
      ],
      { PUBLISH_RELAY_API_KEY: 'test-key' },
    );
    expect(result.code).toBe(0);
    expect(paths).toEqual([
      `/api/v1/fanvue/accounts/${accountId}/vault/catalog/Paid%20%2F%20%D0%91%D1%8A%D0%BB%D0%B3%D0%B0%D1%80%D1%81%D0%BA%D0%B8?page=2&size=50`,
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: {
        data: [{ uuid: mediaUuid, manualPriceCents: 450, priceVersion: 2, url: '[REDACTED]' }],
      },
    });
  });
  it('routes one selected-fan Fanvue purchase fact with explicit unknown truth', async () => {
    const accountId = '00000000-0000-4000-8000-000000000002';
    const mediaUuid = '00000000-0000-4000-8000-000000000003';
    const fanUuid = '00000000-0000-4000-8000-000000000004';
    const paths: string[] = [];
    const baseUrl = await fixture(
      200,
      { success: true, data: { state: 'unknown', purchasedByFan: null } },
      '00000000-0000-4000-8000-000000000201',
      paths,
    );
    const result = await cli(
      [
        'fanvue',
        'vault-purchase-fact',
        accountId,
        '--media-uuid',
        mediaUuid,
        '--fan-uuid',
        fanUuid,
        '--base-url',
        baseUrl,
      ],
      { PUBLISH_RELAY_API_KEY: 'test-key' },
    );
    expect(result.code).toBe(0);
    expect(paths).toEqual([
      `/api/v1/fanvue/accounts/${accountId}/vault/media/${mediaUuid}/purchase?fanUuid=${fanUuid}`,
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { state: 'unknown', purchasedByFan: null },
    });
  });
  it('routes one Fanvue publication coverage fact with a bounded scan', async () => {
    const accountId = '00000000-0000-4000-8000-000000000002';
    const mediaUuid = '00000000-0000-4000-8000-000000000003';
    const paths: string[] = [];
    const baseUrl = await fixture(
      200,
      {
        success: true,
        data: { state: 'unknown', complete: false, incompleteReason: 'scan_capped' },
      },
      '00000000-0000-4000-8000-000000000201',
      paths,
    );
    const result = await cli(
      [
        'fanvue',
        'vault-publication-fact',
        accountId,
        '--media-uuid',
        mediaUuid,
        '--max-pages',
        '3',
        '--base-url',
        baseUrl,
      ],
      { PUBLISH_RELAY_API_KEY: 'test-key' },
    );
    expect(result.code).toBe(0);
    expect(paths).toEqual([
      `/api/v1/fanvue/accounts/${accountId}/vault/media/${mediaUuid}/publication?maxPages=3`,
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { state: 'unknown', complete: false, incompleteReason: 'scan_capped' },
    });
  });
  it('matches the real account API authentication and response contract', async () => {
    const application = Fastify();
    registerApiKeyRoutes(application, {
      authenticate: (workspaceId: string, secret: string) => {
        expect(workspaceId).toBe('00000000-0000-4000-8000-000000000201');
        expect(secret).toBe('test-key');
        return Promise.resolve({
          id: '00000000-0000-4000-8000-000000000001',
          workspaceId,
          createdByUserId: 'user-1',
          workspaceLabel: 'Atlas',
          prefix: 'pr_public',
          capabilities: ['schedules:read'],
          expiresAt: null,
        });
      },
    } as unknown as ApiKeyService);
    await application.listen({ host: '127.0.0.1', port: 0 });
    servers.push(application.server);
    const address = application.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');

    const result = await cli(
      ['account', 'current', '--base-url', `http://127.0.0.1:${String(address.port)}`],
      { PUBLISH_RELAY_API_KEY: 'test-key' },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      data: {
        id: '00000000-0000-4000-8000-000000000001',
        workspaceId: '00000000-0000-4000-8000-000000000201',
        workspaceLabel: 'Atlas',
        prefix: 'pr_public',
        capabilities: ['schedules:read'],
        expiresAt: null,
      },
    });
  });

  it.each([
    [401, 3],
    [403, 4],
    [400, 5],
    [404, 5],
    [422, 5],
    [409, 6],
    [429, 7],
    [500, 8],
    [424, 9],
  ])('maps HTTP %i to stable exit %i while redacting the envelope', async (status, exit) => {
    const body = {
      success: false,
      error: {
        code: `error_${String(status)}`,
        message: 'safe',
        requestId: 'request-1',
        details: { accessToken: 'provider-secret', reason: 'private provider response' },
      },
    };
    const baseUrl = await fixture(status, body);
    const result = await cli(['posts', 'show', 'post-1', '--base-url', baseUrl], {
      PUBLISH_RELAY_API_KEY: 'test-key',
    });
    expect(result.code).toBe(exit);
    expect(JSON.parse(result.stdout)).toEqual({
      success: false,
      error: {
        code: `error_${String(status)}`,
        message: 'safe',
        requestId: 'request-1',
        details: { accessToken: '[REDACTED]', reason: '[REDACTED]' },
      },
    });
    expect(result.stdout).not.toContain('test-key');
    expect(result.stdout).not.toContain('provider-secret');
    expect(result.stdout).not.toContain('private provider response');
  });

  it('redacts nested success fields while preserving durable IDs and direct links', async () => {
    const baseUrl = await fixture(200, {
      success: true,
      data: {
        id: 'job-1',
        state: 'published',
        providerToken: 'provider-secret',
        nested: { password: 'credential' },
        createdAt: '2026-08-31T21:00:00.000Z',
        updatedAt: '2026-08-31T21:01:00.000Z',
        scheduledAt: '2026-08-31T21:02:00.000Z',
        links: { self: '/api/v1/jobs/job-1', post: '/api/v1/posts/post-1' },
      },
      meta: { requestId: 'request-success', internalTrace: 'private-trace' },
    });
    const result = await cli(['publishes', 'show', 'job-1', '--base-url', baseUrl], {
      PUBLISH_RELAY_API_KEY: 'test-key',
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      data: {
        id: 'job-1',
        state: 'published',
        providerToken: '[REDACTED]',
        nested: '[REDACTED]',
        createdAt: '2026-08-31T21:00:00.000Z',
        updatedAt: '2026-08-31T21:01:00.000Z',
        scheduledAt: '2026-08-31T21:02:00.000Z',
        links: { self: '/api/v1/jobs/job-1', post: '/api/v1/posts/post-1' },
      },
      meta: { requestId: 'request-success', internalTrace: '[REDACTED]' },
    });
    expect(result.stdout).not.toContain('provider-secret');
    expect(result.stdout).not.toContain('credential');
    expect(result.stdout).not.toContain('private-trace');
  });

  it('preserves the posts list contract while redacting injected nested fields', async () => {
    const baseUrl = await fixture(200, {
      success: true,
      data: {
        items: [
          {
            id: 'post-1',
            createdAt: '2026-08-31T21:00:00.000Z',
            updatedAt: '2026-08-31T21:01:00.000Z',
            links: { self: '/api/v1/posts/post-1', providerConsole: 'private-url' },
            accessToken: 'provider-secret',
          },
        ],
        nextCursor: 'cursor-1',
      },
      meta: { requestId: 'request-list' },
    });
    const result = await cli(['posts', 'list', '--base-url', baseUrl], {
      PUBLISH_RELAY_API_KEY: 'test-key',
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      data: {
        items: [
          {
            id: 'post-1',
            createdAt: '2026-08-31T21:00:00.000Z',
            updatedAt: '2026-08-31T21:01:00.000Z',
            links: { self: '/api/v1/posts/post-1', providerConsole: '[REDACTED]' },
            accessToken: '[REDACTED]',
          },
        ],
        nextCursor: 'cursor-1',
      },
      meta: { requestId: 'request-list' },
    });
  });

  it('routes publication-list filters and redacts unexpected job fields', async () => {
    const paths: string[] = [];
    const baseUrl = await fixture(
      200,
      {
        success: true,
        data: {
          items: [
            {
              id: 'job-1',
              postId: 'post-1',
              state: 'scheduled',
              scheduledAt: '2027-01-01T00:00:00.000Z',
              updatedAt: '2026-09-01T00:00:00.000Z',
              destination: {
                id: 'account-1',
                displayName: 'Channel',
                provider: 'x',
                token: 'private',
              },
              links: { self: '/api/v1/jobs/job-1', post: '/api/v1/posts/post-1' },
              secretHash: 'private',
            },
          ],
          nextCursor: 'next',
        },
        meta: { requestId: 'list' },
      },
      '00000000-0000-4000-8000-000000000201',
      paths,
    );
    const result = await cli(
      [
        'publishes',
        'list',
        '--base-url',
        baseUrl,
        '--limit',
        '1',
        '--states',
        'scheduled',
        '--scheduledAfter',
        '2026-12-01T00:00:00.000Z',
      ],
      { PUBLISH_RELAY_API_KEY: 'test-key' },
    );
    expect(result.code).toBe(0);
    expect(paths).toEqual([
      '/api/v1/jobs?limit=1&states=scheduled&scheduledAfter=2026-12-01T00%3A00%3A00.000Z',
    ]);
    expect(result.stdout).toContain('"nextCursor":"next"');
    expect(result.stdout).not.toContain('private');
  });

  it('preserves the post detail contract including nested job links', async () => {
    const baseUrl = await fixture(200, {
      success: true,
      data: {
        id: 'post-1',
        revisionId: 'revision-1',
        revisionNumber: 2,
        createdAt: '2026-08-31T21:00:00.000Z',
        updatedAt: '2026-08-31T21:01:00.000Z',
        links: { self: '/api/v1/posts/post-1' },
        jobs: [
          {
            id: 'job-1',
            state: 'queued',
            scheduledAt: '2026-08-31T21:02:00.000Z',
            links: { self: '/api/v1/jobs/job-1' },
            providerToken: 'provider-secret',
          },
        ],
      },
      meta: { requestId: 'request-detail' },
    });
    const result = await cli(['posts', 'show', 'post-1', '--base-url', baseUrl], {
      PUBLISH_RELAY_API_KEY: 'test-key',
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: {
        revisionNumber: 2,
        links: { self: '/api/v1/posts/post-1' },
        jobs: [
          {
            id: 'job-1',
            state: 'queued',
            scheduledAt: '2026-08-31T21:02:00.000Z',
            links: { self: '/api/v1/jobs/job-1' },
            providerToken: '[REDACTED]',
          },
        ],
      },
    });
  });

  it('preflights workspace before a mutation and sends body plus idempotency key', async () => {
    const baseUrl = await fixture(201, {
      success: true,
      data: {
        id: 'post-1',
        revisionId: 'revision-1',
        links: { self: '/api/v1/posts/post-1', jobs: ['/api/v1/jobs/job-1'] },
      },
      meta: { requestId: 'request-2' },
    });
    const directory = await mkdtemp(join(tmpdir(), 'publish-relay-cli-'));
    const bodyFile = join(directory, 'body.json');
    await writeFile(bodyFile, '{"content":{"type":"text","text":"hello"}}');
    const result = await cli(
      [
        'posts',
        'create',
        '--base-url',
        baseUrl,
        '--require-workspace',
        '00000000-0000-4000-8000-000000000201',
        '--idempotency-key',
        'idem-1',
        '--body-file',
        bodyFile,
      ],
      { PUBLISH_RELAY_API_KEY: 'test-key' },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      data: {
        id: 'post-1',
        revisionId: 'revision-1',
        links: { self: '/api/v1/posts/post-1', jobs: ['/api/v1/jobs/job-1'] },
      },
    });
  });

  it('rejects secret-bearing profile fields before making a request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'publish-relay-cli-profile-'));
    const profile = join(directory, 'profile.json');
    await writeFile(profile, '{"baseUrl":"https://example.invalid","apiKey":"secret"}');
    const result = await cli(['health', '--profile-file', profile]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('may not contain secret material');
  });

  it('rejects secret-bearing command-line flags', async () => {
    const result = await cli(['health', '--api-key', 'secret']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('load secrets from the environment');
  });

  it('lists destination summaries while redacting unexpected provider fields', async () => {
    const paths: string[] = [];
    const baseUrl = await fixture(
      200,
      {
        success: true,
        data: {
          nextCursor: 'page-two',
          items: [
            {
              id: 'destination-1',
              provider: 'meta',
              destinationProvider: 'instagram',
              displayName: '@studio',
              status: 'active',
              availability: 'active',
              remoteParentAccountId: 'page-one',
              capabilitySnapshot: {
                schemaVersion: 1,
                contentKinds: ['single_image', 'carousel'],
                media: { minImages: 1, maxImages: 10 },
              },
              capabilitiesCheckedAt: '2026-09-07T20:00:00.000Z',
              capabilityFreshness: 'fresh',
              updatedAt: '2026-09-07T20:00:00.000Z',
              credentialId: 'private',
            },
          ],
        },
        meta: { requestId: 'request-destinations' },
      },
      '00000000-0000-4000-8000-000000000201',
      paths,
    );
    const result = await cli(['destinations', 'list', '--base-url', baseUrl], {
      PUBLISH_RELAY_API_KEY: 'test-key',
    });
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as { data: { items: unknown[]; nextCursor: string } };
    expect(output.data.nextCursor).toBe('page-two');
    expect(output.data.items[0]).toEqual({
      id: 'destination-1',
      provider: 'meta',
      destinationProvider: 'instagram',
      displayName: '@studio',
      status: 'active',
      availability: 'active',
      remoteParentAccountId: 'page-one',
      capabilitySnapshot: {
        schemaVersion: 1,
        contentKinds: ['single_image', 'carousel'],
        media: { minImages: 1, maxImages: 10 },
      },
      capabilitiesCheckedAt: '2026-09-07T20:00:00.000Z',
      capabilityFreshness: 'fresh',
      updatedAt: '2026-09-07T20:00:00.000Z',
      credentialId: '[REDACTED]',
    });
    const next = await cli(
      ['destinations', 'list', '--base-url', baseUrl, '--cursor', 'page-two'],
      {
        PUBLISH_RELAY_API_KEY: 'test-key',
      },
    );
    expect(next.code).toBe(0);
    expect(JSON.parse(next.stdout)).toMatchObject({ data: { nextCursor: 'page-two' } });
    expect(paths).toEqual(['/api/v1/destinations', '/api/v1/destinations?cursor=page-two']);
  });

  it('returns exit 10 and the durable job ID when bounded polling times out', async () => {
    const baseUrl = await fixture(200, {
      success: true,
      data: { id: 'job-1', state: 'dispatching' },
      meta: { requestId: 'request-3' },
    });
    const result = await cli(
      [
        'publishes',
        'poll',
        'job-1',
        '--base-url',
        baseUrl,
        '--poll-timeout-ms',
        '20',
        '--poll-interval-ms',
        '5',
      ],
      { PUBLISH_RELAY_API_KEY: 'test-key' },
    );
    expect(result.code).toBe(10);
    expect(JSON.parse(result.stdout)).toMatchObject({
      jobId: 'job-1',
      links: { job: '/api/v1/jobs/job-1' },
    });
  });

  it('preflights and retries a publication with an idempotency key', async () => {
    const baseUrl = await fixture(202, {
      success: true,
      data: { id: 'job-1', state: 'retry_wait', links: { self: '/api/v1/jobs/job-1' } },
      meta: { requestId: 'request-retry' },
    });
    const result = await cli(
      ['publishes', 'retry', 'job-1', '--base-url', baseUrl, '--idempotency-key', 'retry-job-1'],
      { PUBLISH_RELAY_API_KEY: 'test-key' },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { id: 'job-1', state: 'retry_wait', links: { self: '/api/v1/jobs/job-1' } },
    });
  });

  it('preserves the full effective YouTube settings snapshot when polling completes', async () => {
    const effectiveProviderSettings = {
      schemaVersion: 1,
      title: 'Scheduled clip',
      privacyStatus: 'public',
      madeForKids: false,
      notifySubscribers: true,
    };
    const baseUrl = await fixture(200, {
      success: true,
      data: { id: 'job-1', state: 'published', effectiveProviderSettings },
      meta: { requestId: 'request-4' },
    });
    const result = await cli(
      ['publishes', 'poll', 'job-1', '--base-url', baseUrl, '--poll-timeout-ms', '100'],
      { PUBLISH_RELAY_API_KEY: 'test-key' },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { id: 'job-1', effectiveProviderSettings },
    });
  });
});
