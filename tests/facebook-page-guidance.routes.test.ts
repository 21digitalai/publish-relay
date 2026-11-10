import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerFacebookPageGuidanceRoutes } from '../src/modules/credentials/facebook-page-guidance.routes.js';
import { MachineAuthorizationError } from '../src/modules/identity/machine-auth.js';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), read: vi.fn(), update: vi.fn() }));
vi.mock('../src/modules/identity/machine-auth.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  authorizePageEngagementRequest: mocks.authorize,
}));
vi.mock('../src/modules/credentials/facebook-page-guidance.service.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  getFacebookPageGuidance: mocks.read,
  updateFacebookPageGuidance: mocks.update,
}));

const page = '00000000-0000-4000-8000-000000000004';
const sibling = '00000000-0000-4000-8000-000000000005';
const guidance = { profile: 'Private context', dmGuidance: '', commentGuidance: '' };

describe('Page guidance machine API', () => {
  it('denies sibling Page reads and writes before touching guidance storage', async () => {
    const app = Fastify();
    mocks.authorize.mockImplementation(
      (
        _request: unknown,
        _keys: unknown,
        _delegated: unknown,
        _database: unknown,
        accountId: string,
      ) => {
        if (accountId === sibling)
          throw new MachineAuthorizationError('Page guidance access unavailable');
        return {
          workspaceId: '00000000-0000-4000-8000-000000000001',
          actorId: page,
          kind: 'api-key',
        };
      },
    );
    mocks.read.mockResolvedValue(guidance);
    mocks.update.mockResolvedValue(guidance);
    registerFacebookPageGuidanceRoutes(
      app,
      {} as never,
      undefined,
      {} as never,
      { check: () => ({ allowed: true }) } as never,
    );
    try {
      const get = await app.inject({
        method: 'GET',
        url: `/api/v1/facebook-pages/${sibling}/guidance`,
      });
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/v1/facebook-pages/${sibling}/guidance`,
        payload: guidance,
      });
      expect(get.statusCode).toBe(403);
      expect(patch.statusCode).toBe(403);
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.authorize).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        undefined,
        expect.anything(),
        sibling,
        'facebook:guidance:read',
      );
      expect(mocks.authorize).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        undefined,
        expect.anything(),
        sibling,
        'facebook:guidance:write',
      );
      expect(
        (await app.inject({ method: 'GET', url: `/api/v1/facebook-pages/${page}/guidance` }))
          .statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });
});
