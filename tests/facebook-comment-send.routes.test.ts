import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MachineAuthorizationError } from '../src/modules/identity/machine-auth.js';
import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import { registerFacebookPageCommentSendRoute } from '../src/modules/providers/facebook-comment-send.routes.js';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), send: vi.fn() }));
vi.mock('../src/modules/identity/machine-auth.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  authorizePageEngagementRequest: mocks.authorize,
}));
vi.mock('../src/modules/providers/facebook-comment-send.service.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  sendAccountPageCommentReply: mocks.send,
}));

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const clientActionId = '00000000-0000-4000-8000-000000000003';
const path = `/api/v1/destinations/${accountId}/facebook-posts/123_456/comments/123_456_789/replies`;

beforeEach(() => vi.clearAllMocks());

async function appForTest() {
  const app = Fastify();
  registerFacebookPageCommentSendRoute(
    app,
    { database: {} as never, keys: {} as never, client: {} as never, policy: {} as never },
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

describe('Facebook Page comment reply machine route', () => {
  it('requires exact comments:send and projects only an outcome receipt', async () => {
    const app = await appForTest();
    try {
      mocks.authorize.mockResolvedValue({
        workspaceId,
        actorId: '00000000-0000-4000-8000-000000000004',
        kind: 'api-key',
      });
      mocks.send.mockResolvedValue({ state: 'confirmed', commentId: 'reply_9' });
      const response = await app.inject({
        method: 'POST',
        url: path,
        payload: { clientActionId, text: 'Hello' },
      });
      expect(response.statusCode).toBe(201);
      expect(mocks.authorize).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        undefined,
        expect.anything(),
        accountId,
        'comments:send',
      );
      expect(mocks.send).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          workspaceId,
          accountId,
          postId: '123_456',
          commentId: '123_456_789',
          clientActionId,
          text: 'Hello',
        }),
      );
      expect(response.json()).toEqual(
        expect.objectContaining({
          data: { state: 'confirmed', commentId: 'reply_9' },
        }),
      );
      expect(response.body).not.toMatch(/accessToken|postId|credentialId|server-token/);
    } finally {
      await app.close();
    }
  });

  it('does not send with a read-only key or absent Page-local send grant', async () => {
    const app = await appForTest();
    try {
      mocks.authorize.mockRejectedValue(new MachineAuthorizationError('comments:send denied'));
      const response = await app.inject({
        method: 'POST',
        url: path,
        payload: { clientActionId, text: 'Hello' },
      });
      expect(response.statusCode).toBe(403);
      expect(mocks.send).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not reach the service without authentication or valid input', async () => {
    const app = await appForTest();
    try {
      mocks.authorize.mockResolvedValue(null);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: path,
            payload: { clientActionId, text: 'Hello' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: path,
            payload: { clientActionId, text: '' },
          })
        ).statusCode,
      ).toBe(400);
      expect(mocks.send).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
