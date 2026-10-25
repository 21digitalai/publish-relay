import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerFacebookPageBrowserReadRoutes } from '../src/modules/providers/facebook-page-browser-read.routes.js';
import { PageReadUnavailableError } from '../src/modules/providers/facebook-page-read-context.service.js';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  posts: vi.fn(),
  comments: vi.fn(),
  conversations: vi.fn(),
  messages: vi.fn(),
}));
vi.mock('../src/modules/identity/auth.routes.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  authorizeRequest: mocks.authorize,
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
const path = `/api/provider-accounts/${accountId}`;

async function createApp() {
  const app = Fastify();
  registerFacebookPageBrowserReadRoutes(
    app,
    { database: {} as never, keys: {} as never, client: {} as never },
    {} as never,
  );
  await app.ready();
  return app;
}

afterEach(() => vi.clearAllMocks());

describe('Facebook browser Page reads', () => {
  it('requires authenticated content read and validates the bounded query', async () => {
    const app = await createApp();
    try {
      mocks.authorize.mockResolvedValue(null);
      expect((await app.inject(`${path}/facebook-posts`)).statusCode).toBe(401);
      mocks.authorize.mockResolvedValue({ workspaceId });
      expect((await app.inject(`${path}/facebook-posts?limit=101`)).statusCode).toBe(400);
      expect(mocks.posts).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('binds the selected workspace and post and does not cache visitor content', async () => {
    const app = await createApp();
    try {
      mocks.authorize.mockResolvedValue({ workspaceId });
      mocks.comments.mockResolvedValue({ comments: [], nextCursor: null });
      const response = await app.inject(`${path}/facebook-posts/123_456/comments?limit=5`);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(mocks.comments).toHaveBeenCalledWith(expect.anything(), {
        workspaceId,
        accountId,
        postId: '123_456',
        limit: 5,
      });
      expect(response.json()).toMatchObject({
        data: { comments: [], nextCursor: null },
        error: null,
      });
    } finally {
      await app.close();
    }
  });

  it('hides unavailable or foreign Page state from the browser', async () => {
    const app = await createApp();
    try {
      mocks.authorize.mockResolvedValue({ workspaceId });
      mocks.conversations.mockRejectedValue(new PageReadUnavailableError());
      const response = await app.inject(`${path}/facebook-conversations`);
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toMatch(/token|credential|providerGrant/);
    } finally {
      await app.close();
    }
  });

  it('binds browser message reads to the selected account without caching', async () => {
    const app = await createApp();
    try {
      mocks.authorize.mockResolvedValue({ workspaceId });
      mocks.messages.mockResolvedValue({ participantId: 'psid_7', messages: [], nextCursor: null });
      const response = await app.inject(`${path}/facebook-conversations/t_123/messages`);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(mocks.messages).toHaveBeenCalledWith(expect.anything(), {
        workspaceId,
        accountId,
        conversationId: 't_123',
      });
    } finally {
      await app.close();
    }
  });
});
