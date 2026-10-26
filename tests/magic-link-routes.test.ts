import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createStandaloneApplication,
  registerCoreApplication,
} from '../src/application/create-application.js';
import { registerMagicLinkRoutes } from '../src/modules/identity/magic-link.routes.js';
import type { MagicLinkService } from '../src/modules/identity/magic-link.service.js';

const service = {
  requestAccess: vi.fn<MagicLinkService['requestAccess']>(),
  verify: vi.fn<MagicLinkService['verify']>(),
  requestLogin: vi.fn<MagicLinkService['requestLogin']>(),
  verifyLogin: vi.fn<MagicLinkService['verifyLogin']>(),
  requestSignup: vi.fn<MagicLinkService['requestSignup']>(),
  verifySignup: vi.fn<MagicLinkService['verifySignup']>(),
};

function createApp() {
  const app = Fastify();
  app.register(cookie);
  registerMagicLinkRoutes(app, service as unknown as MagicLinkService, { secureCookies: false });
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe('magic-link routes', () => {
  it('returns the same neutral request response while forwarding request bindings', async () => {
    vi.mocked(service.requestAccess).mockResolvedValue({ accepted: true });
    const response = await createApp().inject({
      method: 'POST',
      url: '/api/auth/magic-link/request',
      headers: { 'user-agent': 'test-browser' },
      payload: { email: 'owner@example.test', redirectPath: '/app' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      data: {
        accepted: true,
        message: 'If the email can be used, a sign-in link is on its way.',
      },
      error: null,
    });
    expect(service.requestAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'owner@example.test',
        redirectPath: '/app',
        networkKey: '127.0.0.1',
        userAgent: 'test-browser',
      }),
    );
  });

  it('rejects an unsafe redirect at the HTTP boundary', async () => {
    const response = await createApp().inject({
      method: 'POST',
      url: '/api/auth/magic-link/request',
      payload: { email: 'owner@example.test', redirectPath: '//attacker.example' },
    });
    expect(response.statusCode).toBe(400);
    expect(service.requestAccess).not.toHaveBeenCalled();
  });

  it('uses distinct client buckets behind the local proxy but ignores forged remote headers', async () => {
    vi.mocked(service.requestAccess).mockResolvedValue({ accepted: true });
    const app = createStandaloneApplication({
      config: {
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: 3100,
        WORKER_POLL_INTERVAL_MS: 1000,
        PUBLISH_RELAY_HUMAN_AUTH_MODE: 'magic_link',
      },
      magicLinks: service as unknown as MagicLinkService,
    });
    try {
      for (const client of ['203.0.113.11', '203.0.113.12']) {
        await app.inject({
          method: 'POST',
          url: '/api/auth/magic-link/request',
          remoteAddress: '127.0.0.1',
          headers: { 'x-forwarded-for': client },
          payload: { email: 'owner@example.test' },
        });
      }
      await app.inject({
        method: 'POST',
        url: '/api/auth/magic-link/request',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.99, 203.0.113.13' },
        payload: { email: 'owner@example.test' },
      });
      await app.inject({
        method: 'POST',
        url: '/api/auth/magic-link/request',
        remoteAddress: '198.51.100.20',
        headers: { 'x-forwarded-for': '203.0.113.99' },
        payload: { email: 'owner@example.test' },
      });
      expect(
        vi.mocked(service.requestAccess).mock.calls.map(([input]) => input.networkKey),
      ).toEqual(['203.0.113.11', '203.0.113.12', '203.0.113.13', '198.51.100.20']);
    } finally {
      await app.close();
    }
  });

  it('never consumes or creates a session on Telegram-like GET/HEAD previews', async () => {
    const app = createApp();
    for (const path of ['verify', 'verify-signup']) {
      for (const method of ['GET', 'HEAD'] as const) {
        const response = await app.inject({
          method,
          url: `/api/auth/magic-link/${path}?token=${'t'.repeat(43)}`,
          headers: { 'user-agent': 'TelegramBot' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(response.headers['cache-control']).toContain('no-store');
        expect(response.headers['referrer-policy']).toBe('no-referrer');
        if (method === 'GET') {
          expect(response.body).toContain('<button class="auth-confirmation-submit"');
          expect(response.body).toContain(`action="/api/auth/magic-link/${path}"`);
          expect(response.body).toContain('history.replaceState');
        }
      }
    }
    expect(service.verify).not.toHaveBeenCalled();
  });

  it('sets one session cookie and redirects only after deliberate Continue POST', async () => {
    vi.mocked(service.verify).mockResolvedValue({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      role: 'owner',
      token: 'session-token',
      csrfToken: 'csrf-token',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
      redirectPath: '/app',
    });
    const app = createApp();
    const page = await app.inject({
      method: 'GET',
      url: `/api/auth/magic-link/verify?token=${'t'.repeat(43)}`,
      headers: { 'user-agent': 'test-browser' },
    });
    expect(page.statusCode).toBe(200);
    expect(service.verify).not.toHaveBeenCalled();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/magic-link/verify',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${'t'.repeat(43)}`,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/app');
    expect(response.headers.location).not.toContain('token');
    expect(service.verify).toHaveBeenCalledTimes(1);
    expect(response.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('publish_relay_session=workspace-1.session-token'),
        expect.stringContaining('publish_relay_csrf=csrf-token'),
      ]),
    );
  });

  it('redeems a native form when a composing host provides a string body parser', async () => {
    vi.mocked(service.verify)
      .mockResolvedValueOnce({
        userId: 'user-1',
        workspaceId: 'workspace-1',
        role: 'owner',
        token: 'session-token',
        csrfToken: 'csrf-token',
        expiresAt: new Date('2030-01-01T00:00:00Z'),
        redirectPath: '/app',
      })
      .mockResolvedValueOnce(null);
    const app = Fastify();
    app.register(cookie);
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, body);
      },
    );
    registerCoreApplication(app, {
      config: {
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: 3100,
        WORKER_POLL_INTERVAL_MS: 1000,
        PUBLISH_RELAY_HUMAN_AUTH_MODE: 'magic_link',
      },
      magicLinks: service as unknown as MagicLinkService,
    });
    try {
      const payload = `token=${'t'.repeat(43)}`;
      const first = await app.inject({
        method: 'POST',
        url: '/api/auth/magic-link/verify',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload,
      });
      expect(first.statusCode).toBe(302);
      expect(first.headers.location).toBe('/app');
      expect(first.headers['set-cookie']).toBeDefined();
      const replay = await app.inject({
        method: 'POST',
        url: '/api/auth/magic-link/verify',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload,
      });
      expect(replay.headers.location).toBe('/login?magicLink=invalid');
      expect(replay.headers['set-cookie']).toBeUndefined();
      expect(service.verify).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('redirects invalid and replayed POST without setting cookies', async () => {
    vi.mocked(service.verify).mockResolvedValue(null);
    const response = await createApp().inject({
      method: 'POST',
      url: '/api/auth/magic-link/verify',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${'t'.repeat(43)}`,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login?magicLink=invalid');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(service.verify).toHaveBeenCalledTimes(1);
  });

  it('uses the same email-only request and verification routes for a new account', async () => {
    vi.mocked(service.requestAccess).mockResolvedValue({
      accepted: true,
      developmentUrl: 'https://relay.example/verify?token=secret',
    });
    const requested = await createApp().inject({
      method: 'POST',
      url: '/api/auth/magic-link/request',
      headers: { 'user-agent': 'test-browser' },
      payload: { email: 'owner@example.test' },
    });
    expect(requested.statusCode).toBe(202);
    expect(requested.json<{ data: unknown }>().data).toEqual({
      accepted: true,
      message: 'If the email can be used, a sign-in link is on its way.',
      developmentUrl: 'https://relay.example/verify?token=secret',
    });
    const requestInput = vi.mocked(service.requestAccess).mock.calls[0]?.[0];
    expect(requestInput).not.toHaveProperty('displayName');
    expect(requestInput).not.toHaveProperty('workspaceName');
    vi.mocked(service.verify).mockResolvedValue({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      role: 'owner',
      token: 'session-token',
      csrfToken: 'csrf-token',
      expiresAt: new Date('2030-01-01'),
      redirectPath: '/app',
    });
    const verified = await createApp().inject({
      method: 'POST',
      url: '/api/auth/magic-link/verify-signup',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${'t'.repeat(43)}`,
    });
    expect(verified.statusCode).toBe(302);
    expect(verified.headers.location).toBe('/app');
  });
});
