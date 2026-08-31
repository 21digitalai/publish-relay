import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApplication } from '../src/application/create-application.js';
import { AuthService, type AuthStore } from '../src/modules/identity/auth.service.js';
import { hashPassword } from '../src/modules/identity/password.js';

const applications = [] as ReturnType<typeof createApplication>[];
afterEach(async () =>
  Promise.all(applications.splice(0).map((application) => application.close())),
);

function createStore(): AuthStore {
  return {
    register: vi.fn().mockResolvedValue({ userId: 'u1', workspaceId: 'w1', role: 'owner' }),
    findLogin: vi.fn(),
    createSession: vi.fn(),
    revokeSessionsForUser: vi.fn(),
    revokeSession: vi.fn(),
    findSession: vi.fn(),
    findCurrentRole: vi.fn(),
  };
}

function createTestApplication(store: AuthStore) {
  const application = createApplication(
    { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3100, WORKER_POLL_INTERVAL_MS: 1000 },
    new AuthService(store),
  );
  applications.push(application);
  return application;
}

function createProductionApplication(store: AuthStore) {
  const application = createApplication(
    { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: 3100, WORKER_POLL_INTERVAL_MS: 1000 },
    new AuthService(store),
  );
  applications.push(application);
  return application;
}

describe('authentication HTTP boundary', () => {
  it('registers an account and returns only the identity contract', async () => {
    const response = await createTestApplication(createStore()).inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'owner@example.test', password: 'long-password', workspaceName: 'Relay' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      data: { userId: 'u1', workspaceId: 'w1', role: 'owner' },
      error: null,
    });
  });

  it('rotates login state, protects the shell, and requires CSRF for logout', async () => {
    const store = createStore();
    vi.mocked(store.findLogin).mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w1',
      role: 'owner',
      passwordHash: await hashPassword('long-password'),
    });
    vi.mocked(store.findSession).mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w1',
      role: 'owner',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });
    vi.mocked(store.findCurrentRole).mockResolvedValue('owner');
    const application = createTestApplication(store);
    const login = await application.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@example.test', password: 'long-password' },
    });
    const cookies = login.cookies;
    const cookieHeader = cookies.map((item) => `${item.name}=${item.value}`).join('; ');
    expect(cookies.find((item) => item.name === 'publish_relay_session')?.httpOnly).toBe(true);
    expect(
      (await application.inject({ method: 'GET', url: '/app', headers: { cookie: cookieHeader } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await application.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { cookie: cookieHeader },
        })
      ).statusCode,
    ).toBe(403);
    const csrf = cookies.find((item) => item.name === 'publish_relay_csrf')?.value;
    expect(
      (
        await application.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { cookie: cookieHeader, 'x-csrf-token': csrf ?? '' },
        })
      ).statusCode,
    ).toBe(200);
    expect(store.revokeSession).toHaveBeenCalledOnce();
  });

  it('sets secure cookies in production behind a TLS-terminating reverse proxy', async () => {
    const store = createStore();
    vi.mocked(store.findLogin).mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w1',
      role: 'owner',
      passwordHash: await hashPassword('long-password'),
    });
    const response = await createProductionApplication(store).inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@example.test', password: 'long-password' },
    });
    expect(response.cookies).toHaveLength(2);
    expect(response.cookies.every((cookie) => cookie.secure)).toBe(true);
  });

  it('denies a session cookie when its workspace is substituted', async () => {
    const store = createStore();
    vi.mocked(store.findSession).mockImplementation((workspaceId) =>
      Promise.resolve(
        workspaceId === 'w1'
          ? {
              userId: 'u1',
              workspaceId: 'w1',
              role: 'owner',
              expiresAt: new Date(Date.now() + 60_000),
              revokedAt: null,
            }
          : null,
      ),
    );
    vi.mocked(store.findCurrentRole).mockResolvedValue('owner');
    const response = await createTestApplication(store).inject({
      method: 'GET',
      url: '/app',
      headers: { cookie: 'publish_relay_session=w2.token' },
    });
    expect(response.statusCode).toBe(401);
    expect(store.findSession).toHaveBeenCalledWith('w2', expect.any(String));
    expect(store.findCurrentRole).not.toHaveBeenCalled();
  });

  it('denies a session when live membership lookup no longer authorizes it', async () => {
    const store = createStore();
    vi.mocked(store.findSession).mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w1',
      role: 'owner',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });
    vi.mocked(store.findCurrentRole).mockResolvedValue(null);
    const response = await createTestApplication(store).inject({
      method: 'GET',
      url: '/app',
      headers: { cookie: 'publish_relay_session=w1.token' },
    });
    expect(response.statusCode).toBe(401);
  });
});
