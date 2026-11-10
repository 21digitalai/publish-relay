import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import { registerFacebookPageCommentScheduleRoutes } from '../src/modules/providers/facebook-comment-schedule.routes.js';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), schedule: vi.fn() }));
vi.mock('../src/modules/identity/machine-auth.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  authorizePageEngagementRequest: mocks.authorize,
}));
vi.mock('../src/modules/providers/facebook-comment-schedule.service.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  scheduleAccountPageCommentReply: mocks.schedule,
}));

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const clientActionId = '00000000-0000-4000-8000-000000000003';
const dueAt = '2026-11-10T10:00:00Z';
const path = `/api/v1/destinations/${accountId}/facebook-posts/123_456/comments/123_456_789/replies/schedule`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({
    workspaceId,
    actorId: '00000000-0000-4000-8000-000000000004',
    kind: 'api-key',
  });
});

describe('Facebook Page comment schedule route', () => {
  it('returns a narrow receipt for an exact replay even after its due time', async () => {
    const app = Fastify();
    registerFacebookPageCommentScheduleRoutes(
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
    mocks.schedule.mockResolvedValue({ id: clientActionId, status: 'confirmed', dueAt });
    try {
      const response = await app.inject({
        method: 'POST',
        url: path,
        payload: { clientActionId, text: 'Hello later', dueAt },
      });
      expect(response.statusCode).toBe(202);
      expect(mocks.authorize).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        undefined,
        expect.anything(),
        accountId,
        'comments:send',
      );
      expect(mocks.schedule).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          workspaceId,
          accountId,
          postId: '123_456',
          commentId: '123_456_789',
          clientActionId,
        }),
      );
      expect(response.json()).toEqual(
        expect.objectContaining({ data: { id: clientActionId, status: 'confirmed', dueAt } }),
      );
      expect(response.body).not.toMatch(/accessToken|credentialId|server-token|postId|commentId/);
    } finally {
      await app.close();
    }
  });
});
