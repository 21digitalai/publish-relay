import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as InstagramLoginService from '../src/modules/providers/instagram-login.service.js';

vi.mock('../src/modules/providers/instagram-login.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof InstagramLoginService>()),
  beginInstagramLogin: vi.fn(),
  completeInstagramLogin: vi.fn(),
  failInstagramLogin: vi.fn(),
}));

import { createStandaloneApplication } from '../src/application/create-application.js';
import type { MasterKeyProvider } from '../src/modules/credentials/envelope.js';
import { AuthService, type AuthStore } from '../src/modules/identity/auth.service.js';
import {
  InstagramLoginAccountError,
  InstagramLoginDiagnosticError,
  InstagramLoginRequestError,
  InstagramLoginPermissionError,
} from '../src/modules/providers/instagram-login-client.js';
import {
  beginInstagramLogin,
  completeInstagramLogin,
  failInstagramLogin,
  InstagramLoginPersistenceError,
} from '../src/modules/providers/instagram-login.service.js';

const applications = [] as ReturnType<typeof createStandaloneApplication>[];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

function application(configured: boolean) {
  const store = {
    register: vi.fn(),
    findLogin: vi.fn(),
    findReviewerLogin: vi.fn(),
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
          instagramOauth: {
            keys,
            client: {} as never,
            callbackUrl: 'https://relay.test/api/oauth/instagram/callback',
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

describe('Instagram Login routes', () => {
  it('fails closed before state issuance when separate Instagram credentials are absent', async () => {
    const response = await application(false).inject({
      method: 'POST',
      url: '/api/oauth/instagram',
      headers: csrf,
    });
    expect(response.statusCode).toBe(503);
    expect(beginInstagramLogin).not.toHaveBeenCalled();
  });

  it('requires session and CSRF, then starts only the dedicated Instagram route', async () => {
    const app = application(true);
    expect(
      (await app.inject({ method: 'POST', url: '/api/oauth/instagram', headers: sessionCookie }))
        .statusCode,
    ).toBe(403);
    vi.mocked(beginInstagramLogin).mockResolvedValue({
      authorizationUrl: 'https://www.instagram.com/oauth/authorize?scope=instagram_business_basic',
      expiresAt: new Date('2026-10-09T12:00:00Z'),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/oauth/instagram',
      headers: csrf,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: { authorizationUrl: string }; error: null }>();
    expect(new URL(body.data.authorizationUrl).origin).toBe('https://www.instagram.com');
    expect(body.error).toBeNull();
    expect(vi.mocked(beginInstagramLogin).mock.calls[0]?.[3]).toMatchObject({
      workspaceId: 'w1',
      userId: 'u1',
      callbackUrl: 'https://relay.test/api/oauth/instagram/callback',
    });
  });

  it('maps consumed, replayed, partial, and ineligible callbacks to safe results', async () => {
    const app = application(true);
    vi.mocked(completeInstagramLogin).mockResolvedValue({ connectionId: 'connection' });
    const callback = (query: string) =>
      app.inject({
        method: 'GET',
        url: `/api/oauth/instagram/callback?${query}`,
        headers: sessionCookie,
      });
    expect((await callback('state=one&code=code')).headers.location).toBe(
      '/app?oauth=instagram-connected',
    );
    vi.mocked(completeInstagramLogin).mockResolvedValue(null);
    expect((await callback('state=one&code=code')).headers.location).toBe(
      '/app?oauth=instagram-expired',
    );
    vi.mocked(completeInstagramLogin).mockRejectedValue(new InstagramLoginPermissionError());
    expect((await callback('state=one&code=code')).headers.location).toBe(
      '/app?oauth=instagram-permissions',
    );
    vi.mocked(completeInstagramLogin).mockRejectedValue(new InstagramLoginAccountError());
    expect((await callback('state=one&code=code')).headers.location).toBe(
      '/app?oauth=instagram-no-account',
    );
    vi.mocked(completeInstagramLogin).mockRejectedValue(new InstagramLoginPersistenceError());
    expect((await callback('state=one&code=code')).headers.location).toBe(
      '/app?oauth=instagram-service-error',
    );
    vi.mocked(failInstagramLogin).mockResolvedValue(true);
    expect((await callback('state=one&error=access_denied')).headers.location).toBe(
      '/app?oauth=instagram-denied',
    );
  });

  it('logs only allowlisted failure diagnostics for a sensitive callback', async () => {
    const app = application(true);
    const warnings: unknown[][] = [];
    app.addHook('onRequest', (request, _reply, done) => {
      vi.spyOn(request.log, 'warn').mockImplementation((...values: unknown[]) => {
        warnings.push(values);
      });
      done();
    });
    vi.mocked(completeInstagramLogin).mockRejectedValue(
      Object.assign(new InstagramLoginRequestError('token-exchange', 400), {
        accessToken: 'private-token',
        responseBody: 'private-body',
      }),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/oauth/instagram/callback?state=private-state&code=private-code',
      headers: sessionCookie,
    });
    expect(response.headers.location).toBe('/app?oauth=instagram-service-error');
    expect(warnings).toEqual([
      [
        {
          provider: 'instagram',
          reason: 'service-error',
          stage: 'token-exchange',
          category: 'http',
          status: 400,
        },
        'Instagram Login callback failed',
      ],
    ]);
    const logged = JSON.stringify(warnings);
    expect(logged).not.toContain('private-state');
    expect(logged).not.toContain('private-code');
    expect(logged).not.toContain('private-token');
    expect(logged).not.toContain('private-body');
  });

  it('logs only fixed shape labels for an Instagram token schema failure', async () => {
    const app = application(true);
    const warnings: unknown[][] = [];
    app.addHook('onRequest', (request, _reply, done) => {
      vi.spyOn(request.log, 'warn').mockImplementation((...values: unknown[]) => {
        warnings.push(values);
      });
      done();
    });
    vi.mocked(completeInstagramLogin).mockRejectedValue(
      new InstagramLoginDiagnosticError('token-exchange', 'invalid-response', undefined, {
        root: 'object',
        data: 'single',
        accessToken: 'string',
        userId: 'number',
        permissions: 'missing',
      }),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/oauth/instagram/callback?state=private-state&code=private-code',
      headers: sessionCookie,
    });
    expect(response.headers.location).toBe('/app?oauth=instagram-service-error');
    expect(warnings).toEqual([
      [
        {
          provider: 'instagram',
          reason: 'service-error',
          stage: 'token-exchange',
          category: 'invalid-response',
          responseShape: {
            root: 'object',
            data: 'single',
            accessToken: 'string',
            userId: 'number',
            permissions: 'missing',
          },
        },
        'Instagram Login callback failed',
      ],
    ]);
    const logged = JSON.stringify(warnings);
    expect(logged).not.toContain('private-state');
    expect(logged).not.toContain('private-code');
  });
});
