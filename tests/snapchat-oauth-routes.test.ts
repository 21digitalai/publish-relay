import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/providers/snapchat-oauth.service.js', () => ({
  beginSnapchatOauthConnection: vi.fn(),
  completeSnapchatOauthConnection: vi.fn(),
}));

import { createStandaloneApplication } from '../src/application/create-application.js';
import type { MasterKeyProvider } from '../src/modules/credentials/envelope.js';
import { ProviderDestinationConflictError } from '../src/modules/credentials/provider-connection.repository.js';
import { AuthService, type AuthStore } from '../src/modules/identity/auth.service.js';
import { allowAllActionPolicy } from '../src/modules/policy/action-policy.js';
import {
  beginSnapchatOauthConnection,
  completeSnapchatOauthConnection,
} from '../src/modules/providers/snapchat-oauth.service.js';

const applications = [] as ReturnType<typeof createStandaloneApplication>[];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

function application(authenticated: boolean) {
  const store: AuthStore = {
    register: vi.fn(),
    findLogin: vi.fn(),
    findReviewerLogin: vi.fn(),
    createSession: vi.fn(),
    revokeSessionsForUser: vi.fn(),
    revokeSession: vi.fn(),
    findSession: vi.fn(),
    findCurrentRole: vi.fn(),
    findShellProfile: vi.fn(),
    findWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    listWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
    reorderWorkspaces: vi.fn(),
    deleteWorkspace: vi.fn(),
    rotateWorkspaceSession: vi.fn(),
  };
  if (authenticated) {
    vi.mocked(store.findSession).mockResolvedValue({
      userId: 'user',
      workspaceId: 'workspace',
      role: 'owner',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });
    vi.mocked(store.findCurrentRole).mockResolvedValue('owner');
  }
  const keys: MasterKeyProvider = {
    currentVersion: () => 'v1',
    getKey: () => Promise.resolve(Buffer.alloc(32)),
  };
  const app = createStandaloneApplication({
    config: { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3100, WORKER_POLL_INTERVAL_MS: 1000 },
    auth: new AuthService(store),
    database: {} as NodePgDatabase,
    actionPolicy: allowAllActionPolicy,
    snapchatOauth: {
      keys,
      client: {} as never,
      callbackUrl: 'https://relay.test/api/oauth/snapchat/callback',
    },
  });
  applications.push(app);
  return app;
}

const session = 'publish_relay_session=w1.token';
const csrf = { cookie: `${session}; publish_relay_csrf=csrf`, 'x-csrf-token': 'csrf' };

describe('Snapchat OAuth HTTP boundary', () => {
  it('requires session and CSRF before any start/callback service call', async () => {
    expect(
      (await application(false).inject({ method: 'POST', url: '/api/oauth/snapchat' })).statusCode,
    ).toBe(401);
    const app = application(true);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/oauth/snapchat',
          headers: { cookie: session },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/oauth/snapchat/callback?state=x',
          headers: { cookie: session },
        })
      ).statusCode,
    ).toBe(400);
    expect(beginSnapchatOauthConnection).not.toHaveBeenCalled();
    expect(completeSnapchatOauthConnection).not.toHaveBeenCalled();
  });

  it('starts, redirects on success, rejects replay, and maps destination conflict without secrets', async () => {
    const app = application(true);
    vi.mocked(beginSnapchatOauthConnection).mockResolvedValue({
      authorizationUrl: 'https://accounts.snapchat.com/login/oauth2/authorize',
      expiresAt: new Date('2026-10-02'),
    });
    const start = await app.inject({ method: 'POST', url: '/api/oauth/snapchat', headers: csrf });
    expect(start.json()).toMatchObject({
      data: { authorizationUrl: 'https://accounts.snapchat.com/login/oauth2/authorize' },
      error: null,
    });
    vi.mocked(completeSnapchatOauthConnection)
      .mockResolvedValueOnce({ connectionId: 'id', accounts: [] })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new ProviderDestinationConflictError());
    const callback = () =>
      app.inject({
        method: 'GET',
        url: '/api/oauth/snapchat/callback?state=state&code=secret-code',
        headers: { cookie: session },
      });
    expect((await callback()).headers.location).toBe('/app?oauth=snapchat-connected');
    expect((await callback()).statusCode).toBe(400);
    const conflict = await callback();
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).not.toContain('secret-code');
  });
});
