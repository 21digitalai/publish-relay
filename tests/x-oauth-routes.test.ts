import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApplication } from '../src/application/create-application.js';
import type { MasterKeyProvider } from '../src/modules/credentials/envelope.js';
import { AuthService, type AuthStore } from '../src/modules/identity/auth.service.js';
import { XHttpClient } from '../src/modules/providers/x-http-client.js';

const applications = [] as ReturnType<typeof createApplication>[];
afterEach(async () =>
  Promise.all(applications.splice(0).map((application) => application.close())),
);

function createStore(): AuthStore {
  return {
    register: vi.fn(),
    findLogin: vi.fn(),
    createSession: vi.fn(),
    revokeSessionsForUser: vi.fn(),
    revokeSession: vi.fn(),
    findSession: vi.fn(),
    findCurrentRole: vi.fn(),
    findWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    listWorkspaces: vi.fn(),
    rotateWorkspaceSession: vi.fn(),
  };
}

function createXApplication(store: AuthStore) {
  const keys: MasterKeyProvider = {
    currentVersion: () => 'v1',
    getKey: () => Promise.resolve(Buffer.alloc(32)),
  };
  const application = createApplication(
    { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3100, WORKER_POLL_INTERVAL_MS: 1000 },
    new AuthService(store),
    undefined,
    undefined,
    {} as NodePgDatabase,
    {
      keys,
      client: new XHttpClient({ consumerKey: 'key', consumerSecret: 'secret' }),
      callbackUrl: 'https://relay.example.test/api/oauth/x/callback',
    },
  );
  applications.push(application);
  return application;
}

describe('X OAuth HTTP boundary', () => {
  it('requires a live session for initiation and callback', async () => {
    const application = createXApplication(createStore());
    expect((await application.inject({ method: 'POST', url: '/api/oauth/x' })).statusCode).toBe(
      401,
    );
    expect(
      (
        await application.inject({
          method: 'GET',
          url: '/api/oauth/x/callback?oauth_token=request&oauth_verifier=verifier',
        })
      ).statusCode,
    ).toBe(401);
  });

  it('requires CSRF before initiating an external authorization flow', async () => {
    const store = createStore();
    vi.mocked(store.findSession).mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w1',
      role: 'owner',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });
    vi.mocked(store.findCurrentRole).mockResolvedValue('owner');
    const response = await createXApplication(store).inject({
      method: 'POST',
      url: '/api/oauth/x',
      headers: { cookie: 'publish_relay_session=w1.token' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ data: null, error: 'CSRF validation failed' });
  });

  it('rejects incomplete callback correlation before touching provider state', async () => {
    const store = createStore();
    vi.mocked(store.findSession).mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w1',
      role: 'owner',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });
    vi.mocked(store.findCurrentRole).mockResolvedValue('owner');
    const response = await createXApplication(store).inject({
      method: 'GET',
      url: '/api/oauth/x/callback?oauth_token=request',
      headers: { cookie: 'publish_relay_session=w1.token' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ data: null, error: 'Invalid X OAuth callback' });
  });
});
