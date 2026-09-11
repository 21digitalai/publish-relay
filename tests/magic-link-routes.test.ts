import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerMagicLinkRoutes } from '../src/modules/identity/magic-link.routes.js';
import type { MagicLinkService } from '../src/modules/identity/magic-link.service.js';

const service = {
  requestLogin: vi.fn(),
  verifyLogin: vi.fn(),
} as unknown as MagicLinkService;

function createApp() {
  const app = Fastify();
  app.register(cookie);
  registerMagicLinkRoutes(app, service, { secureCookies: false });
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe('magic-link routes', () => {
  it('returns the same neutral request response while forwarding request bindings', async () => {
    vi.mocked(service.requestLogin).mockResolvedValue({ accepted: true });
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
        message: 'If an account exists, a sign-in link is on its way.',
      },
      error: null,
    });
    expect(service.requestLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'owner@example.test',
        redirectPath: '/app',
        networkKey: '127.0.0.1',
        userAgent: 'test-browser',
      }),
    );
  });

  it('sets the secure session cookies and redirects only after successful verification', async () => {
    vi.mocked(service.verifyLogin).mockResolvedValue({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      role: 'owner',
      token: 'session-token',
      csrfToken: 'csrf-token',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
      redirectPath: '/app',
    });
    const response = await createApp().inject({
      method: 'GET',
      url: `/api/auth/magic-link/verify?token=${'t'.repeat(43)}`,
      headers: { 'user-agent': 'test-browser' },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/app');
    expect(response.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('publish_relay_session=workspace-1.session-token'),
        expect.stringContaining('publish_relay_csrf=csrf-token'),
      ]),
    );
  });

  it('redirects invalid and replayed links without setting cookies', async () => {
    vi.mocked(service.verifyLogin).mockResolvedValue(null);
    const response = await createApp().inject({
      method: 'GET',
      url: `/api/auth/magic-link/verify?token=${'t'.repeat(43)}`,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login?magicLink=invalid');
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
