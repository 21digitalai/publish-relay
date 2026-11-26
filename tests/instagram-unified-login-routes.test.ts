import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as InstagramUnifiedLoginService from '../src/modules/providers/instagram-unified-login.service.js';

vi.mock('../src/modules/providers/instagram-unified-login.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof InstagramUnifiedLoginService>()),
  beginInstagramUnifiedLogin: vi.fn(),
  completeInstagramUnifiedLogin: vi.fn(),
  failInstagramUnifiedLogin: vi.fn(),
}));

import { createStandaloneApplication } from '../src/application/create-application.js';
import type { MasterKeyProvider } from '../src/modules/credentials/envelope.js';
import { AuthService, type AuthStore } from '../src/modules/identity/auth.service.js';
import { ProviderDestinationConflictError } from '../src/modules/credentials/provider-connection.repository.js';
import {
  beginInstagramUnifiedLogin,
  completeInstagramUnifiedLogin,
  failInstagramUnifiedLogin,
} from '../src/modules/providers/instagram-unified-login.service.js';

const applications = [] as ReturnType<typeof createStandaloneApplication>[];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

function application(configured: boolean) {
  const store = {
    register: vi.fn(),
    findLogin: vi.fn(),
    createSession: vi.fn(),
    revokeSessionsForUser: vi.fn(),
    revokeSession: vi.fn(),
    findSession: vi.fn().mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w1',
      role: 'owner',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    }),
    findCurrentRole: vi.fn().mockResolvedValue('owner'),
    findShellProfile: vi.fn(),
    findWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    listWorkspaces: vi.fn(),
    rotateWorkspaceSession: vi.fn(),
    createWorkspace: vi.fn(),
    reorderWorkspaces: vi.fn(),
    deleteWorkspace: vi.fn(),
  } as AuthStore;
  const keys: MasterKeyProvider = {
    currentVersion: () => 'v1',
    getKey: () => Promise.resolve(Buffer.alloc(32)),
  };
  const app = createStandaloneApplication({
    config: { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3100, WORKER_POLL_INTERVAL_MS: 1000 },
    auth: new AuthService(store),
    database: {} as NodePgDatabase,
    ...(configured
      ? {
          instagramUnifiedOauth: {
            keys,
            client: {} as never,
            callbackUrl: 'https://relay.test/api/oauth/instagram-unified/callback',
          },
        }
      : {}),
  });
  applications.push(app);
  return app;
}

const csrf = {
  cookie: 'publish_relay_session=w1.token; publish_relay_csrf=csrf',
  'x-csrf-token': 'csrf',
};
const sessionCookie = { cookie: 'publish_relay_session=w1.token' };

describe('Instagram Unified Login routes', () => {
  it('fails closed when the opt-in configuration is incomplete', async () => {
    const response = await application(false).inject({
      method: 'POST',
      url: '/api/oauth/instagram-unified',
      headers: csrf,
    });
    expect(response.statusCode).toBe(503);
    expect(beginInstagramUnifiedLogin).not.toHaveBeenCalled();
  });

  it('requires CSRF and binds the start request to the authenticated tenant', async () => {
    const app = application(true);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/oauth/instagram-unified',
          headers: sessionCookie,
        })
      ).statusCode,
    ).toBe(403);
    vi.mocked(beginInstagramUnifiedLogin).mockResolvedValue({
      authorizationUrl: 'https://www.facebook.com/v23.0/dialog/oauth?state=opaque',
      expiresAt: new Date('2026-10-09T12:00:00Z'),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/oauth/instagram-unified',
      headers: csrf,
    });
    expect(response.statusCode).toBe(200);
    expect(vi.mocked(beginInstagramUnifiedLogin).mock.calls[0]?.[3]).toMatchObject({
      workspaceId: 'w1',
      userId: 'u1',
      callbackUrl: 'https://relay.test/api/oauth/instagram-unified/callback',
    });
  });

  it('maps malformed and denied callbacks to safe, one-use outcomes', async () => {
    const app = application(true);
    const callback = (query: string) =>
      app.inject({
        method: 'GET',
        url: `/api/oauth/instagram-unified/callback?${query}`,
        headers: sessionCookie,
      });
    expect((await callback('code=missing-state')).headers.location).toBe(
      '/app?oauth=instagram-unified-expired',
    );
    expect(completeInstagramUnifiedLogin).not.toHaveBeenCalled();
    vi.mocked(failInstagramUnifiedLogin).mockResolvedValue(true);
    expect((await callback('state=opaque&error=access_denied')).headers.location).toBe(
      '/app?oauth=instagram-unified-denied',
    );
    expect(vi.mocked(failInstagramUnifiedLogin).mock.calls[0]?.[2]).toMatchObject({
      workspaceId: 'w1',
      userId: 'u1',
      state: 'opaque',
    });
  });

  it('keeps success and duplicate/no-overwrite conflicts distinct', async () => {
    const app = application(true);
    vi.mocked(completeInstagramUnifiedLogin).mockResolvedValue({
      connectionId: 'connection-1',
      accountCount: 1,
    });
    const callback = () =>
      app.inject({
        method: 'GET',
        url: '/api/oauth/instagram-unified/callback?state=opaque&code=one-use',
        headers: sessionCookie,
      });
    expect((await callback()).headers.location).toBe('/app?oauth=instagram-unified-connected');
    expect(vi.mocked(completeInstagramUnifiedLogin).mock.calls[0]?.[3]).toMatchObject({
      workspaceId: 'w1',
      userId: 'u1',
      state: 'opaque',
      code: 'one-use',
    });
    vi.mocked(completeInstagramUnifiedLogin).mockRejectedValue(
      new ProviderDestinationConflictError(),
    );
    expect((await callback()).headers.location).toBe('/app?oauth=instagram-unified-conflict');
  });
});
