import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/identity/auth.routes.js', () => ({
  authorizeRequest: vi.fn(),
  CSRF_COOKIE: 'publish_relay_csrf',
}));
vi.mock('../src/modules/credentials/provider-account.service.js', () => ({
  disconnectProviderAccount: vi.fn(),
  listProviderAccounts: vi.fn(() => Promise.resolve([])),
  updateYouTubeAccountDefaults: vi.fn(() => Promise.resolve('updated')),
}));

import { authorizeRequest } from '../src/modules/identity/auth.routes.js';
import {
  listProviderAccounts,
  updateYouTubeAccountDefaults,
} from '../src/modules/credentials/provider-account.service.js';
import { registerProviderAccountRoutes } from '../src/modules/credentials/provider-account.routes.js';

const accountId = '00000000-0000-4000-8000-000000000204';
const identity = { workspaceId: 'workspace-1', userId: 'user-1' };

async function application() {
  const app = Fastify();
  await app.register(cookie);
  registerProviderAccountRoutes(app, { auth: {} as never, database: {} as never });
  return app;
}

describe('provider account routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authorizeRequest).mockResolvedValue(identity as never);
    vi.mocked(updateYouTubeAccountDefaults).mockResolvedValue('updated');
  });

  it('keeps the account list allowlisted and requests read authorization', async () => {
    vi.mocked(listProviderAccounts).mockResolvedValue([
      {
        id: accountId,
        provider: 'youtube',
        displayName: 'Channel',
        status: 'active',
        adapterDefaults: { madeForKids: false },
        updatedAt: new Date('2026-09-01T00:00:00Z'),
      },
    ]);
    const response = await (
      await application()
    ).inject({ method: 'GET', url: '/api/provider-accounts' });
    expect(response.statusCode).toBe(200);
    expect(authorizeRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'content:read',
    );
    expect(response.body).toContain('adapterDefaults');
    expect(response.body).not.toContain('credentialId');
    expect(response.body).not.toContain('connectionId');
  });

  it('requires management authorization and CSRF for strict YouTube defaults', async () => {
    const app = await application();
    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/provider-accounts/${accountId}/youtube-defaults`,
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(updateYouTubeAccountDefaults).not.toHaveBeenCalled();
    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/provider-accounts/${accountId}/youtube-defaults`,
      headers: { cookie: 'publish_relay_csrf=token', 'x-csrf-token': 'token' },
      payload: { madeForKids: false, internal: 'forbidden' },
    });
    expect(invalid.statusCode).toBe(400);
    const accepted = await app.inject({
      method: 'PATCH',
      url: `/api/provider-accounts/${accountId}/youtube-defaults`,
      headers: { cookie: 'publish_relay_csrf=token', 'x-csrf-token': 'token' },
      payload: { privacyStatus: 'public', madeForKids: false },
    });
    expect(accepted.statusCode).toBe(200);
    expect(authorizeRequest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      'workspace:manage',
    );
    expect(updateYouTubeAccountDefaults).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        accountId,
      }),
    );
  });

  it('returns authentication and scoped-account failures without mutating', async () => {
    const app = await application();
    vi.mocked(authorizeRequest).mockResolvedValueOnce(null);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/provider-accounts/${accountId}/youtube-defaults`,
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    vi.mocked(updateYouTubeAccountDefaults).mockResolvedValueOnce('missing');
    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/provider-accounts/${accountId}/youtube-defaults`,
      headers: { cookie: 'publish_relay_csrf=token', 'x-csrf-token': 'token' },
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
  });
});
