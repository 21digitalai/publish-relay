import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorizeHuman: vi.fn(),
  authorizeMachine: vi.fn(),
  send: vi.fn(),
}));

vi.mock('../src/modules/identity/auth.routes.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  authorizeRequest: mocks.authorizeHuman,
}));
vi.mock('../src/modules/identity/machine-auth.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  authorizeMachineRequest: mocks.authorizeMachine,
}));
vi.mock('../src/modules/providers/instagram-unified-send.service.js', () => {
  class MockActionConflictError extends Error {}
  class MockEligibilityError extends Error {}
  return {
    createInstagramUnifiedSendService: () => ({ send: mocks.send }),
    InstagramUnifiedActionConflictError: MockActionConflictError,
    InstagramUnifiedEligibilityError: MockEligibilityError,
  };
});

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import {
  registerInstagramUnifiedSendApiRoutes,
  registerInstagramUnifiedSendRoutes,
} from '../src/modules/providers/instagram-unified-send.routes.js';
import { InstagramUnifiedEligibilityError } from '../src/modules/providers/instagram-unified-send.service.js';
import { InstagramUnifiedReadError } from '../src/modules/providers/instagram-unified-read-client.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const actionId = '00000000-0000-4000-8000-000000000003';
const payload = {
  clientActionId: actionId,
  kind: 'comment_reply',
  targetId: 'comment-1',
  parentId: 'media-1',
  text: 'Hello',
};

function runtime() {
  return { database: {} as never, keys: {} as never, client: {} as never };
}

async function appForTest() {
  const app = Fastify();
  registerInstagramUnifiedSendRoutes(app, runtime(), {} as never);
  registerInstagramUnifiedSendApiRoutes(
    app,
    runtime(),
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeHuman.mockResolvedValue({ workspaceId, userId: actionId });
  mocks.authorizeMachine.mockResolvedValue({ workspaceId, actorId: actionId, kind: 'api-key' });
  mocks.send.mockResolvedValue({ state: 'confirmed', receipt: 'receipt-1' });
});

describe('Instagram Unified manual reply routes', () => {
  it('rejects malformed browser actions before the send service', async () => {
    const app = await appForTest();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/provider-accounts/${accountId}/instagram-unified-actions`,
        payload: { ...payload, text: '' },
      });
      expect(response.statusCode).toBe(400);
      expect(mocks.send).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('maps an ineligible browser action to a safe conflict without provider details', async () => {
    mocks.send.mockRejectedValueOnce(new InstagramUnifiedEligibilityError());
    const app = await appForTest();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/provider-accounts/${accountId}/instagram-unified-actions`,
        payload,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        data: null,
        error: 'Unified Instagram reply is not currently eligible',
      });
    } finally {
      await app.close();
    }
  });

  it('uses the action-specific machine grant and exposes only bounded receipt data', async () => {
    const app = await appForTest();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/destinations/${accountId}/instagram-unified-actions`,
        payload,
      });
      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body) as { data: unknown; error: unknown };
      expect(result.data).toEqual({ state: 'confirmed', receipt: 'receipt-1' });
      expect(mocks.authorizeMachine).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        undefined,
        'comments:send',
      );
      expect(response.body).not.toContain('accessToken');
    } finally {
      await app.close();
    }
  });

  it('preserves typed provider permission errors on the machine route', async () => {
    mocks.send.mockRejectedValueOnce(new InstagramUnifiedReadError('permission', 403));
    const app = await appForTest();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/destinations/${accountId}/instagram-unified-actions`,
        payload,
      });
      expect(response.statusCode).toBe(403);
      const result = JSON.parse(response.body) as { error: { code: string } };
      expect(result.error.code).toBe('instagram_unified_permission');
      expect(response.body).not.toContain('provider body');
    } finally {
      await app.close();
    }
  });
});
