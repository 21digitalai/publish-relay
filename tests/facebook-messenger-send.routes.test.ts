import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import { registerFacebookPageDmSendRoute } from '../src/modules/providers/facebook-messenger-send.routes.js';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), send: vi.fn() }));
vi.mock('../src/modules/identity/machine-auth.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  authorizePageEngagementRequest: mocks.authorize,
}));
vi.mock('../src/modules/providers/facebook-messenger-send.service.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  sendAccountPageConversationMessage: mocks.send,
}));

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const clientActionId = '00000000-0000-4000-8000-000000000003';
const path = `/api/v1/destinations/${accountId}/facebook-conversations/t_123/messages`;

beforeEach(() => vi.clearAllMocks());

async function appForTest() {
  const app = Fastify();
  registerFacebookPageDmSendRoute(
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

describe('Facebook Page DM send machine route', () => {
  it('requires exact dms:send and projects only an outcome receipt', async () => {
    const app = await appForTest();
    try {
      mocks.authorize.mockResolvedValue({
        workspaceId,
        actorId: '00000000-0000-4000-8000-000000000004',
        kind: 'api-key',
      });
      mocks.send.mockResolvedValue({ state: 'confirmed', messageId: 'mid_9' });
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
        'dms:send',
      );
      expect(mocks.send).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          workspaceId,
          accountId,
          conversationId: 't_123',
          clientActionId,
          text: 'Hello',
        }),
      );
      expect(response.json()).toEqual(
        expect.objectContaining({
          data: { state: 'confirmed', messageId: 'mid_9' },
        }),
      );
      expect(response.body).not.toMatch(/accessToken|recipientId|credentialId|server-token/);
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
