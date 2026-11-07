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
  proposal: vi.fn(),
  action: vi.fn(),
  link: vi.fn(),
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
  getAccountConversationLink: mocks.link,
}));
vi.mock('../src/modules/providers/engagement-proposal.repository.js', () => ({
  getEngagementProposal: mocks.proposal,
}));
vi.mock('../src/modules/providers/facebook-dm-history.repository.js', () => ({
  getPageDmSendAction: mocks.action,
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
  it('opens exact Graph link through tenant-owned proposal and send rows without exposing Graph IDs', async () => {
    const app = await createApp();
    try {
      mocks.authorize.mockResolvedValue({ workspaceId });
      mocks.proposal.mockResolvedValue({
        provider: 'facebook_page',
        kind: 'dm',
        accountId,
        targetId: 't_123',
      });
      mocks.action.mockResolvedValue({ accountId, conversationId: 't_456' });
      mocks.link
        .mockResolvedValueOnce('https://www.facebook.com/messages/t/123')
        .mockResolvedValueOnce('https://m.me/eli.page');
      const proposal = await app.inject(
        '/api/facebook-page-dm-link/proposal/00000000-0000-4000-8000-000000000003',
      );
      const send = await app.inject(
        '/api/facebook-page-dm-link/send/00000000-0000-4000-8000-000000000004',
      );
      expect(proposal.statusCode).toBe(302);
      expect(proposal.headers.location).toBe('https://www.facebook.com/messages/t/123');
      expect(send.headers.location).toBe('https://m.me/eli.page');
      expect(mocks.link).toHaveBeenNthCalledWith(2, expect.anything(), {
        workspaceId,
        accountId,
        conversationId: 't_456',
      });
      expect(proposal.headers['cache-control']).toBe('no-store');
    } finally {
      await app.close();
    }
  });

  it('denies unauthenticated and foreign rows before Graph access', async () => {
    const app = await createApp();
    try {
      mocks.authorize.mockResolvedValueOnce(null).mockResolvedValue({ workspaceId });
      const path = '/api/facebook-page-dm-link/proposal/00000000-0000-4000-8000-000000000003';
      expect((await app.inject(path)).statusCode).toBe(401);
      mocks.proposal.mockResolvedValue(null);
      expect((await app.inject(path)).statusCode).toBe(404);
      mocks.proposal.mockResolvedValue({
        provider: 'fanvue',
        kind: 'dm',
        accountId,
        targetId: 't_123',
      });
      expect((await app.inject(path)).statusCode).toBe(404);
      expect(mocks.link).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('fails closed when a selected Page grant or safe destination is unavailable', async () => {
    const app = await createApp();
    try {
      mocks.authorize.mockResolvedValue({ workspaceId });
      mocks.action.mockResolvedValue({ accountId, conversationId: 't_456' });
      const path = '/api/facebook-page-dm-link/send/00000000-0000-4000-8000-000000000004';
      mocks.link.mockResolvedValueOnce(null).mockRejectedValueOnce(new PageReadUnavailableError());
      expect((await app.inject(path)).statusCode).toBe(404);
      const denied = await app.inject(path);
      expect(denied.statusCode).toBe(404);
      expect(denied.body).not.toMatch(/t_456|token|credential/);
    } finally {
      await app.close();
    }
  });
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
