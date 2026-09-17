import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/providers/meta-oauth.service.js', () => ({
  beginMetaOauthConnection: vi.fn(),
  completeMetaOauthConnection: vi.fn(),
  failMetaOauthConnection: vi.fn(),
  revokeMetaConnection: vi.fn(),
}));

import { createApplication } from '../src/application/create-application.js';
import type { MasterKeyProvider } from '../src/modules/credentials/envelope.js';
import { AuthService, type AuthStore } from '../src/modules/identity/auth.service.js';
import { allowAllActionPolicy } from '../src/modules/policy/action-policy.js';
import {
  beginMetaOauthConnection,
  completeMetaOauthConnection,
  failMetaOauthConnection,
  revokeMetaConnection,
} from '../src/modules/providers/meta-oauth.service.js';

const applications = [] as ReturnType<typeof createApplication>[];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

function store(authenticated: boolean): AuthStore {
  const value: AuthStore = {
    register: vi.fn(),
    findLogin: vi.fn(),
    createSession: vi.fn(),
    revokeSessionsForUser: vi.fn(),
    revokeSession: vi.fn(),
    findSession: vi.fn(),
    findCurrentRole: vi.fn(),
    findShellProfile: vi.fn(),
    findWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    listWorkspaces: vi.fn(),
    rotateWorkspaceSession: vi.fn(),
  };
  if (authenticated) {
    vi.mocked(value.findSession).mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w1',
      role: 'owner',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });
    vi.mocked(value.findCurrentRole).mockResolvedValue('owner');
  }
  return value;
}

function application(authenticated: boolean) {
  const keys: MasterKeyProvider = {
    currentVersion: () => 'v1',
    getKey: () => Promise.resolve(Buffer.alloc(32)),
  };
  const app = createApplication(
    { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3100, WORKER_POLL_INTERVAL_MS: 1000 },
    new AuthService(store(authenticated)),
    undefined,
    undefined,
    {} as NodePgDatabase,
    undefined,
    undefined,
    allowAllActionPolicy,
    undefined,
    undefined,
    { keys, client: {} as never, callbackUrl: 'https://relay.test/api/oauth/meta/callback' },
  );
  applications.push(app);
  return app;
}

const session = 'publish_relay_session=w1.token';
const csrf = { cookie: `${session}; publish_relay_csrf=csrf`, 'x-csrf-token': 'csrf' };

describe('Meta OAuth routes', () => {
  it('requires authentication and CSRF', async () => {
    expect(
      (await application(false).inject({ method: 'POST', url: '/api/oauth/meta' })).statusCode,
    ).toBe(401);
    const app = application(true);
    expect(
      (await app.inject({ method: 'POST', url: '/api/oauth/meta', headers: { cookie: session } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/oauth/meta/revoke',
          headers: { cookie: session },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('starts, completes, and revokes through bounded response contracts', async () => {
    const app = application(true);
    vi.mocked(beginMetaOauthConnection).mockResolvedValue({
      authorizationUrl: 'https://graph.facebook.test/dialog/oauth',
      expiresAt: new Date('2026-09-17T16:00:00Z'),
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/oauth/meta', headers: csrf })).json(),
    ).toMatchObject({
      data: { authorizationUrl: 'https://graph.facebook.test/dialog/oauth' },
      error: null,
    });
    vi.mocked(completeMetaOauthConnection).mockResolvedValue({ accounts: [] } as never);
    const callback = await app.inject({
      method: 'GET',
      url: '/api/oauth/meta/callback?state=state&code=code',
      headers: { cookie: session },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/app?oauth=meta-connected');
    vi.mocked(revokeMetaConnection).mockResolvedValue(true);
    expect(
      (await app.inject({ method: 'POST', url: '/api/oauth/meta/revoke', headers: csrf })).json(),
    ).toEqual({ data: { revoked: true }, error: null });
  });

  it('consumes provider-error state and never reflects provider error details', async () => {
    const app = application(true);
    vi.mocked(failMetaOauthConnection).mockResolvedValue(true);
    const response = await app.inject({
      method: 'GET',
      url: '/api/oauth/meta/callback?state=state&error=access_denied&error_description=token-secret',
      headers: { cookie: session },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('token-secret');
    expect(failMetaOauthConnection).toHaveBeenCalledOnce();
    const failureInput = vi.mocked(failMetaOauthConnection).mock.calls[0]?.[2];
    expect(failureInput).toMatchObject({
      workspaceId: 'w1',
      userId: 'u1',
      state: 'state',
    });
    expect(typeof failureInput?.requestId).toBe('string');
  });
});
