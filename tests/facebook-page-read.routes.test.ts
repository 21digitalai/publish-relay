import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import { FacebookRequestError } from '../src/modules/providers/facebook-http-client.js';
import { registerFacebookPageReadRoutes } from '../src/modules/providers/facebook-page-read.routes.js';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  posts: vi.fn(),
  comments: vi.fn(),
  conversations: vi.fn(),
  messages: vi.fn(),
}));
vi.mock('../src/modules/identity/machine-auth.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  authorizePageEngagementRequest: mocks.authorize,
}));
vi.mock('../src/modules/providers/facebook-comments-read.service.js', () => ({
  listAccountPagePosts: mocks.posts,
  listAccountPostComments: mocks.comments,
}));
vi.mock('../src/modules/providers/facebook-messenger-read.service.js', () => ({
  listAccountPageConversations: mocks.conversations,
  listAccountConversationMessages: mocks.messages,
}));

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const path = `/api/v1/destinations/${accountId}`;

async function createApp() {
  const app = Fastify();
  registerFacebookPageReadRoutes(
    app,
    { database: {} as never, keys: {} as never, client: {} as never },
    {} as never,
    new ApiRateLimiter({
      workspace: 100,
      key: 100,
      mutationWorkspace: 100,
      mutationKey: 100,
      windowMs: 60_000,
    }),
  );
  await app.ready();
  return app;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Facebook Page read machine API', () => {
  it('passes the selected-Page eligible filter to the bounded inbox read', async () => {
    const app = await createApp();
    try {
      mocks.authorize.mockResolvedValue({ workspaceId, actorId: 'key' });
      mocks.conversations.mockResolvedValue({ conversations: [], nextCursor: 'opaque-next' });
      const response = await app.inject(`${path}/facebook-conversations?filter=eligible&limit=25`);
      expect(response.statusCode).toBe(200);
      expect(mocks.conversations).toHaveBeenCalledWith(expect.anything(), {
        workspaceId,
        accountId,
        limit: 25,
        filter: 'eligible',
      });
      expect(response.json().data.nextCursor).toBe('opaque-next');
      expect((await app.inject(`${path}/facebook-conversations?filter=untrusted`)).statusCode).toBe(
        400,
      );
    } finally {
      await app.close();
    }
  });
  it('requires authentication and validates bounded query before provider access', async () => {
    const app = await createApp();
    try {
      mocks.authorize.mockResolvedValue(null);
      expect((await app.inject(`${path}/facebook-posts`)).statusCode).toBe(401);
      expect((await app.inject(`${path}/facebook-posts?limit=101`)).statusCode).toBe(400);
      expect(mocks.posts).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('binds the exact Page and capability and exposes only projected fields', async () => {
    const app = await createApp();
    try {
      mocks.authorize.mockResolvedValue({ workspaceId, actorId: 'key' });
      mocks.posts.mockResolvedValue({
        posts: [{ id: '42_99', text: 'Hello', createdAt: '2026-10-25T00:00:00Z', permalink: null }],
        nextCursor: null,
      });
      const response = await app.inject(`${path}/facebook-posts?limit=2&after=opaque`);
      expect(response.statusCode).toBe(200);
      expect(mocks.authorize).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        undefined,
        expect.anything(),
        accountId,
        'comments:read',
      );
      expect(mocks.posts).toHaveBeenCalledWith(expect.anything(), {
        workspaceId,
        accountId,
        limit: 2,
        after: 'opaque',
      });
      expect(response.json()).toMatchObject({
        data: {
          posts: [
            { id: '42_99', text: 'Hello', createdAt: '2026-10-25T00:00:00Z', permalink: null },
          ],
          nextCursor: null,
        },
      });
      expect(JSON.stringify(response.json())).not.toMatch(/accessToken|credentialId|paging\.next/);
    } finally {
      await app.close();
    }
  });

  it('uses the separate DMs capability and does not leak provider failures', async () => {
    const app = await createApp();
    try {
      mocks.authorize.mockResolvedValue({ workspaceId, actorId: 'key' });
      mocks.conversations.mockRejectedValue(
        new FacebookRequestError({
          kind: 'rate_limit',
          status: 403,
          code: 4,
          retryAfterSeconds: 7,
        }),
      );
      const response = await app.inject(`${path}/facebook-conversations`);
      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('7');
      expect(mocks.authorize).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        undefined,
        expect.anything(),
        accountId,
        'dms:read',
      );
      expect(response.body).not.toContain('token');
    } finally {
      await app.close();
    }
  });

  it('routes selected-post comments through the same exact Page authority', async () => {
    const app = await createApp();
    try {
      mocks.authorize.mockResolvedValue({ workspaceId, actorId: 'key' });
      mocks.comments.mockResolvedValue({ comments: [], nextCursor: null });
      const response = await app.inject(`${path}/facebook-posts/123_456/comments?limit=5`);
      expect(response.statusCode).toBe(200);
      expect(mocks.authorize).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        undefined,
        expect.anything(),
        accountId,
        'comments:read',
      );
      expect(mocks.comments).toHaveBeenCalledWith(expect.anything(), {
        workspaceId,
        accountId,
        postId: '123_456',
        limit: 5,
      });
      expect((await app.inject(`${path}/facebook-posts/foreign/comments`)).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('routes selected-conversation messages only through dms:read', async () => {
    const app = await createApp();
    try {
      mocks.authorize.mockResolvedValue({ workspaceId, actorId: 'key' });
      mocks.messages.mockResolvedValue({
        participantId: 'psid_7',
        displayName: 'Birkan Reyhan',
        messages: [],
        nextCursor: null,
      });
      const response = await app.inject(`${path}/facebook-conversations/t_123/messages?limit=5`);
      expect(response.statusCode).toBe(200);
      const payload: unknown = response.json();
      expect(payload).toMatchObject({
        data: { participantId: 'psid_7', displayName: 'Birkan Reyhan' },
      });
      expect(mocks.authorize).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        undefined,
        expect.anything(),
        accountId,
        'dms:read',
      );
      expect(mocks.messages).toHaveBeenCalledWith(expect.anything(), {
        workspaceId,
        accountId,
        conversationId: 't_123',
        limit: 5,
      });
      expect(JSON.stringify(response.json())).not.toMatch(/token|credential|email/);
      expect(Buffer.byteLength(response.body)).toBeLessThan(512);
      expect(
        (await app.inject(`${path}/facebook-conversations/foreign-id/messages`)).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
});
