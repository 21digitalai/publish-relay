import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/providers/youtube-oauth.service.js', () => ({
  beginYouTubeOauthConnection: vi.fn(),
  completeYouTubeOauthConnection: vi.fn(),
}));

import { createStandaloneApplication } from '../src/application/create-application.js';
import type { MasterKeyProvider } from '../src/modules/credentials/envelope.js';
import { AuthService, type AuthStore } from '../src/modules/identity/auth.service.js';
import {
  ActionPolicyDeniedError,
  allowAllActionPolicy,
} from '../src/modules/policy/action-policy.js';
import {
  beginYouTubeOauthConnection,
  completeYouTubeOauthConnection,
} from '../src/modules/providers/youtube-oauth.service.js';

const applications = [] as ReturnType<typeof createStandaloneApplication>[];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

function createStore(authenticated = false): AuthStore {
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
      userId: 'u1',
      workspaceId: 'w1',
      role: 'owner',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });
    vi.mocked(store.findCurrentRole).mockResolvedValue('owner');
  }
  return store;
}

function createYouTubeApplication(authenticated = false) {
  const keys: MasterKeyProvider = {
    currentVersion: () => 'v1',
    getKey: () => Promise.resolve(Buffer.alloc(32)),
  };
  const application = createStandaloneApplication({
    config: { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3100, WORKER_POLL_INTERVAL_MS: 1000 },
    auth: new AuthService(createStore(authenticated)),
    database: {} as NodePgDatabase,
    actionPolicy: allowAllActionPolicy,
    youtubeOauth: {
      keys,
      client: {} as never,
      callbackUrl: 'https://relay.example/api/oauth/youtube/callback',
    },
  });
  applications.push(application);
  return application;
}

const session = 'publish_relay_session=w1.token';
const csrfHeaders = { cookie: `${session}; publish_relay_csrf=csrf`, 'x-csrf-token': 'csrf' };

describe('YouTube OAuth HTTP boundary', () => {
  it('requires authentication for initiation and callback', async () => {
    const app = createYouTubeApplication();
    expect((await app.inject({ method: 'POST', url: '/api/oauth/youtube' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/oauth/youtube/callback?state=s&code=c' }))
        .statusCode,
    ).toBe(401);
  });

  it('requires CSRF for initiation and rejects malformed callbacks before service calls', async () => {
    const app = createYouTubeApplication(true);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/oauth/youtube',
          headers: { cookie: session },
        })
      ).statusCode,
    ).toBe(403);
    const malformed = await app.inject({
      method: 'GET',
      url: '/api/oauth/youtube/callback?state=s',
      headers: { cookie: session },
    });
    expect(malformed.statusCode).toBe(400);
    expect(completeYouTubeOauthConnection).not.toHaveBeenCalled();
  });

  it('returns safe initiation, policy denial, callback redirect, and invalid-state envelopes', async () => {
    const app = createYouTubeApplication(true);
    vi.mocked(beginYouTubeOauthConnection).mockResolvedValueOnce({
      authorizationUrl: 'https://accounts.google.test/auth',
      expiresAt: new Date('2026-09-08T02:00:00.000Z'),
    });
    const started = await app.inject({
      method: 'POST',
      url: '/api/oauth/youtube',
      headers: csrfHeaders,
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      data: { authorizationUrl: 'https://accounts.google.test/auth' },
      error: null,
    });
    vi.mocked(beginYouTubeOauthConnection).mockRejectedValueOnce(
      new ActionPolicyDeniedError({
        allowed: false,
        code: 'blocked',
        reason: 'Connection blocked',
      }),
    );
    const denied = await app.inject({
      method: 'POST',
      url: '/api/oauth/youtube',
      headers: csrfHeaders,
    });
    expect(denied.json()).toEqual({ data: null, error: 'Connection blocked', code: 'blocked' });
    vi.mocked(completeYouTubeOauthConnection)
      .mockResolvedValueOnce({ accounts: [] } as never)
      .mockResolvedValueOnce(null);
    const success = await app.inject({
      method: 'GET',
      url: '/api/oauth/youtube/callback?state=s&code=c',
      headers: { cookie: session },
    });
    expect(success.statusCode).toBe(302);
    expect(success.headers.location).toBe('/app?oauth=youtube-connected');
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/oauth/youtube/callback?state=s&code=c',
      headers: { cookie: session },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({
      data: null,
      error: 'YouTube OAuth transaction is invalid or expired',
    });
  });
});
