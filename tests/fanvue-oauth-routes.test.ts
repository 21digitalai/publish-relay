import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/providers/fanvue-oauth.service.js', () => ({
  FanvueModuleConsentError: class extends Error {
    constructor(
      public readonly reason: string,
      public readonly kind = 'read',
    ) {
      super(reason);
    }
  },
  beginFanvueOauthConnection: vi.fn(),
  completeFanvueOauthConnection: vi.fn(),
  completeFanvueOauthDenial: vi.fn(),
}));

import { createStandaloneApplication } from '../src/application/create-application.js';
import type { MasterKeyProvider } from '../src/modules/credentials/envelope.js';
import { ProviderDestinationConflictError } from '../src/modules/credentials/provider-connection.repository.js';
import { AuthService, type AuthStore } from '../src/modules/identity/auth.service.js';
import { allowAllActionPolicy } from '../src/modules/policy/action-policy.js';
import {
  beginFanvueOauthConnection,
  completeFanvueOauthConnection,
  completeFanvueOauthDenial,
  FanvueModuleConsentError,
} from '../src/modules/providers/fanvue-oauth.service.js';

const applications = [] as ReturnType<typeof createStandaloneApplication>[];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

function application(authenticated: boolean) {
  const store: AuthStore = {
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
    fanvueOauth: {
      keys,
      client: {} as never,
      callbackUrl: 'https://relay.test/api/oauth/fanvue/callback',
    },
  });
  applications.push(app);
  return app;
}

const session = 'publish_relay_session=w1.token';
const csrf = { cookie: `${session}; publish_relay_csrf=csrf`, 'x-csrf-token': 'csrf' };

describe('Fanvue OAuth HTTP boundary', () => {
  it('requires session and CSRF before any start/callback service call', async () => {
    expect(
      (await application(false).inject({ method: 'POST', url: '/api/oauth/fanvue' })).statusCode,
    ).toBe(401);
    const app = application(true);
    expect(
      (await app.inject({ method: 'POST', url: '/api/oauth/fanvue', headers: { cookie: session } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/oauth/fanvue/callback?state=x',
          headers: { cookie: session },
        })
      ).statusCode,
    ).toBe(400);
    expect(beginFanvueOauthConnection).not.toHaveBeenCalled();
    expect(completeFanvueOauthConnection).not.toHaveBeenCalled();
  });

  it('starts, redirects on success, rejects replay, and maps destination conflict without secrets', async () => {
    const app = application(true);
    vi.mocked(beginFanvueOauthConnection).mockResolvedValue({
      authorizationUrl: 'https://www.fanvue.com/v2/auth/authorize/',
      expiresAt: new Date('2026-10-02'),
    });
    const start = await app.inject({ method: 'POST', url: '/api/oauth/fanvue', headers: csrf });
    expect(start.json()).toMatchObject({
      data: { authorizationUrl: 'https://www.fanvue.com/v2/auth/authorize/' },
      error: null,
    });
    vi.mocked(completeFanvueOauthConnection)
      .mockResolvedValueOnce({ connectionId: 'id', accounts: [] })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new ProviderDestinationConflictError());
    const callback = () =>
      app.inject({
        method: 'GET',
        url: '/api/oauth/fanvue/callback?state=state&code=secret-code',
        headers: { cookie: session },
      });
    expect((await callback()).headers.location).toBe('/app?oauth=fanvue-connected');
    expect((await callback()).statusCode).toBe(400);
    const conflict = await callback();
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).not.toContain('secret-code');
  });

  it('keeps optional message-reading consent on the selected account and confirms its separate result', async () => {
    const app = application(true);
    const accountId = '7104f230-83a9-4ce7-9fbc-cd1b42b0dc6a';
    vi.mocked(beginFanvueOauthConnection).mockResolvedValue({
      authorizationUrl: 'https://www.fanvue.com/v2/auth/authorize/',
      expiresAt: new Date('2026-10-02'),
    });
    const start = await app.inject({
      method: 'POST',
      url: '/api/oauth/fanvue',
      headers: csrf,
      payload: { readChatAccountId: accountId },
    });
    expect(start.statusCode).toBe(200);
    expect(beginFanvueOauthConnection).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ readChatAccountId: accountId }),
      expect.anything(),
    );
    vi.mocked(completeFanvueOauthConnection).mockResolvedValueOnce({
      connectionId: 'id',
      accounts: [],
      consentKind: 'read-chat',
    });
    const callback = await app.inject({
      method: 'GET',
      url: '/api/oauth/fanvue/callback?state=state&code=secret-code',
      headers: { cookie: session },
    });
    expect(callback.headers.location).toBe('/app?oauth=fanvue-chat-read-connected');
  });

  it('keeps message-sending consent distinct from reading and reports its outcome', async () => {
    const app = application(true);
    const accountId = '7104f230-83a9-4ce7-9fbc-cd1b42b0dc6a';
    vi.mocked(beginFanvueOauthConnection).mockResolvedValue({
      authorizationUrl: 'https://www.fanvue.com/v2/auth/authorize/',
      expiresAt: new Date('2026-10-02'),
    });
    const start = await app.inject({
      method: 'POST',
      url: '/api/oauth/fanvue',
      headers: csrf,
      payload: { sendChatAccountId: accountId },
    });
    expect(start.statusCode).toBe(200);
    expect(beginFanvueOauthConnection).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ sendChatAccountId: accountId }),
      expect.anything(),
    );
    vi.mocked(completeFanvueOauthConnection).mockResolvedValueOnce({
      connectionId: 'id',
      accounts: [],
      consentKind: 'send-chat',
    });
    const callback = await app.inject({
      method: 'GET',
      url: '/api/oauth/fanvue/callback?state=state&code=secret-code',
      headers: { cookie: session },
    });
    expect(callback.headers.location).toBe('/app?oauth=fanvue-chat-send-connected');
    vi.mocked(completeFanvueOauthDenial).mockResolvedValueOnce('chat-send');
    const denied = await app.inject({
      method: 'GET',
      url: '/api/oauth/fanvue/callback?state=state&error=access_denied',
      headers: { cookie: session },
    });
    expect(denied.headers.location).toBe('/app?oauth=fanvue-chat-send-denied');
  });

  it('keeps payment consent on the selected creator and reports denial separately', async () => {
    const app = application(true);
    const accountId = '7104f230-83a9-4ce7-9fbc-cd1b42b0dc6a';
    vi.mocked(beginFanvueOauthConnection).mockResolvedValue({
      authorizationUrl: 'https://www.fanvue.com/v2/auth/authorize/',
      expiresAt: new Date('2026-10-02'),
    });
    const start = await app.inject({
      method: 'POST',
      url: '/api/oauth/fanvue',
      headers: csrf,
      payload: { paymentAccountId: accountId },
    });
    expect(start.statusCode).toBe(200);
    expect(beginFanvueOauthConnection).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ paymentAccountId: accountId }),
      expect.anything(),
    );
    const mixed = await app.inject({
      method: 'POST',
      url: '/api/oauth/fanvue',
      headers: csrf,
      payload: { paymentAccountId: accountId, sendChatAccountId: accountId },
    });
    expect(mixed.statusCode).toBe(400);
    vi.mocked(completeFanvueOauthConnection).mockResolvedValueOnce({
      connectionId: 'id',
      accounts: [],
      consentKind: 'payment',
    });
    const callback = await app.inject({
      method: 'GET',
      url: '/api/oauth/fanvue/callback?state=state&code=secret-code',
      headers: { cookie: session },
    });
    expect(callback.headers.location).toBe('/app?oauth=fanvue-payment-connected');
    vi.mocked(completeFanvueOauthDenial).mockResolvedValueOnce('payment');
    const denied = await app.inject({
      method: 'GET',
      url: '/api/oauth/fanvue/callback?state=state&error=access_denied',
      headers: { cookie: session },
    });
    expect(denied.headers.location).toBe('/app?oauth=fanvue-payment-denied');
  });

  it('returns actionable account results for rejected chat-read scope, changed creator, and stale account', async () => {
    const app = application(true);
    for (const reason of ['scope', 'account-mismatch', 'unavailable'] as const) {
      vi.mocked(completeFanvueOauthConnection).mockRejectedValueOnce(
        new FanvueModuleConsentError(reason),
      );
      const response = await app.inject({
        method: 'GET',
        url: '/api/oauth/fanvue/callback?state=state&code=secret-code',
        headers: { cookie: session },
      });
      expect(response.headers.location).toBe(`/app?oauth=fanvue-chat-read-${reason}`);
      expect(response.body).not.toContain('secret-code');
    }
  });

  it('consumes a cancelled module grant and returns to the account with a specific recovery state', async () => {
    const app = application(true);
    vi.mocked(completeFanvueOauthDenial).mockResolvedValueOnce('chat-read');
    const response = await app.inject({
      method: 'GET',
      url: '/api/oauth/fanvue/callback?state=state&error=access_denied',
      headers: { cookie: session },
    });
    expect(response.headers.location).toBe('/app?oauth=fanvue-chat-read-denied');
    expect(completeFanvueOauthConnection).not.toHaveBeenCalled();
  });

  it('consumes an invalid-scope callback and redirects without exposing provider details', async () => {
    const app = application(true);
    vi.mocked(completeFanvueOauthDenial).mockResolvedValueOnce('publishing');
    const response = await app.inject({
      method: 'GET',
      url: '/api/oauth/fanvue/callback?state=state&error=invalid_scope&error_description=secret-detail',
      headers: { cookie: session },
    });
    expect(response.headers.location).toBe('/app?oauth=fanvue-scope-unavailable');
    expect(response.body).not.toContain('secret-detail');
    expect(completeFanvueOauthConnection).not.toHaveBeenCalled();
  });
});
