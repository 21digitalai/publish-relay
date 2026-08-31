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
    updateWorkspace: vi.fn(),
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
    const store = createStore();
    const response = await createTestApplication(store).inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        displayName: 'Relay Owner',
        email: 'owner@example.test',
        password: 'long-password',
        workspaceName: 'Relay',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.cookies.map((cookie) => cookie.name)).toEqual([
      'publish_relay_session',
      'publish_relay_csrf',
    ]);
    expect(response.json()).toEqual({
      data: { userId: 'u1', workspaceId: 'w1', role: 'owner' },
      error: null,
    });
    expect(store.register).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Relay Owner', workspaceName: 'Relay' }),
    );
    expect(store.createSession).toHaveBeenCalledOnce();
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

  it('updates the registered workspace in place with owner authorization and CSRF', async () => {
    const store = createStore();
    vi.mocked(store.findSession).mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w1',
      role: 'owner',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });
    vi.mocked(store.findCurrentRole).mockResolvedValue('owner');
    vi.mocked(store.updateWorkspace).mockResolvedValue({
      id: 'w1',
      name: 'Atlas Studio',
      slug: 'atlas-studio',
    });
    const response = await createTestApplication(store).inject({
      method: 'PATCH',
      url: '/api/workspaces/current',
      headers: {
        cookie: 'publish_relay_session=w1.token; publish_relay_csrf=csrf-token',
        'x-csrf-token': 'csrf-token',
      },
      payload: { name: ' Atlas Studio ', slug: 'ATLAS-STUDIO' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { id: 'w1', name: 'Atlas Studio', slug: 'atlas-studio' },
      error: null,
    });
    expect(store.updateWorkspace).toHaveBeenCalledWith('w1', 'u1', {
      name: 'Atlas Studio',
      slug: 'atlas-studio',
    });
  });

  it('returns the same honest recovery-unavailable state without account enumeration', async () => {
    const application = createTestApplication(createStore());
    const known = await application.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: 'known@example.test' },
    });
    const unknown = await application.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: 'unknown@example.test' },
    });
    expect(known.statusCode).toBe(503);
    expect(unknown.statusCode).toBe(503);
    expect(known.json()).toEqual(unknown.json());
    expect(known.json()).toMatchObject({
      data: { status: 'unavailable' },
      error: null,
    });
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
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login');
    expect(store.findSession).toHaveBeenCalledWith('w2', expect.any(String));
    expect(store.findCurrentRole).not.toHaveBeenCalled();
  });

  it('redirects protected deep links before returning shell data', async () => {
    const application = createTestApplication(createStore());
    for (const url of ['/app', '/onboarding/workspace', '/w/atlas/queue']) {
      const response = await application.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/login');
      expect(response.body).not.toContain('Publish Relay');
    }
  });

  it('serves the built application shell on public authentication routes', async () => {
    const application = createTestApplication(createStore());
    for (const url of ['/login', '/register', '/forgot-password']) {
      const response = await application.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('<div id="root"></div>');
      expect(response.body).toContain('/main.tsx');
    }
  });

  it('serves the same application shell after a protected deep link is authorized', async () => {
    const store = createStore();
    vi.mocked(store.findSession).mockResolvedValue({
      userId: 'u1',
      workspaceId: 'w1',
      role: 'owner',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });
    vi.mocked(store.findCurrentRole).mockResolvedValue('owner');
    const response = await createTestApplication(store).inject({
      method: 'GET',
      url: '/w/atlas/queue',
      headers: { cookie: 'publish_relay_session=w1.token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<div id="root"></div>');
    expect(response.body).toContain('/main.tsx');
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
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login');
  });
});
