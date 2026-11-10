import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import { registerFacebookDmMemoryRoutes } from '../src/modules/providers/facebook-dm-memory.routes.js';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), getMany: vi.fn(), upsert: vi.fn() }));
vi.mock('../src/modules/identity/machine-auth.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  authorizePageEngagementRequest: mocks.authorize,
}));
vi.mock('../src/modules/providers/facebook-dm-memory.repository.js', () => ({
  getPageDmMemoryMany: mocks.getMany,
  upsertPageDmMemory: mocks.upsert,
}));

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const base = `/api/v1/destinations/${accountId}/facebook-conversations`;

async function createApp() {
  const app = Fastify();
  registerFacebookDmMemoryRoutes(
    app,
    {} as never,
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

afterEach(() => vi.clearAllMocks());

describe('Page DM memory machine API', () => {
  it('requires Page-local dms:read, validates bounded input, and projects compact records', async () => {
    const app = await createApp();
    try {
      mocks.authorize.mockResolvedValue(null);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/memory/get-many`,
            payload: { conversationIds: ['t_1'] },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/memory/get-many`,
            payload: { conversationIds: Array(101).fill('t_1') },
          })
        ).statusCode,
      ).toBe(400);
      mocks.authorize.mockResolvedValue({ workspaceId, actorId: 'key' });
      mocks.getMany.mockResolvedValue([
        { conversationId: 't_1', facts: ['One fact'], terminal: false },
      ]);
      const response = await app.inject({
        method: 'POST',
        url: `${base}/memory/get-many`,
        payload: { conversationIds: ['t_1'], terminal: 'exclude' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ data: { records: [{ facts: ['One fact'] }] } });
      expect(mocks.authorize).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        undefined,
        expect.anything(),
        accountId,
        'dms:read',
      );
      expect(mocks.getMany).toHaveBeenCalledWith(expect.anything(), {
        workspaceId,
        accountId,
        conversationIds: ['t_1'],
        terminal: 'exclude',
      });
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      await app.close();
    }
  });

  it('rejects transcript-sized facts and updates only submitted fields', async () => {
    const app = await createApp();
    try {
      mocks.authorize.mockResolvedValue({ workspaceId, actorId: 'key' });
      const url = `${base}/t_1/memory`;
      expect(
        (await app.inject({ method: 'PATCH', url, payload: { facts: ['x'.repeat(161)] } }))
          .statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ method: 'PATCH', url, payload: { providerToken: 'secret' } }))
          .statusCode,
      ).toBe(400);
      mocks.upsert.mockResolvedValue({ conversationId: 't_1' });
      const response = await app.inject({ method: 'PATCH', url, payload: { terminal: true } });
      expect(response.statusCode).toBe(200);
      expect(mocks.upsert).toHaveBeenCalledWith(expect.anything(), {
        workspaceId,
        accountId,
        conversationId: 't_1',
        patch: { terminal: true },
      });
      expect(mocks.authorize).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        undefined,
        expect.anything(),
        accountId,
        'dms:propose',
      );
      expect(response.body).not.toContain('secret');
    } finally {
      await app.close();
    }
  });

  it('accepts Meta compact and ISO colon offsets for first contact', async () => {
    const app = await createApp();
    try {
      mocks.authorize.mockResolvedValue({ workspaceId, actorId: 'key' });
      mocks.upsert.mockResolvedValue({ conversationId: 't_1' });
      const url = `${base}/t_1/memory`;
      for (const offset of ['+0000', '+00:00', '-0530', '-05:30']) {
        const response = await app.inject({
          method: 'PATCH',
          url,
          payload: { firstContactAt: `2026-11-09T07:42:13${offset}` },
        });
        expect(response.statusCode).toBe(200);
        expect(mocks.upsert).toHaveBeenLastCalledWith(expect.anything(), {
          workspaceId,
          accountId,
          conversationId: 't_1',
          patch: {
            firstContactAt: new Date(
              `2026-11-09T07:42:13${offset.replace(/(\d{2})(\d{2})$/, '$1:$2')}`,
            ),
          },
        });
      }
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url,
            payload: { firstContactAt: '2026-11-09T07:42:13+2460' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url,
            payload: { firstContactAt: '2026-11-09T07:42:13+0000', extra: true },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
});
