import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerDelegatedAuthorizationRoutes } from '../src/modules/delegated-authorization/delegated-authorization.routes.js';
import {
  DelegatedAuthorizationService,
  type DelegatedAuthorizationStore,
} from '../src/modules/delegated-authorization/delegated-authorization.service.js';
import type { AuthService } from '../src/modules/identity/auth.service.js';

function buildService() {
  const exchangeCode = vi.fn().mockResolvedValue({
    grantId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    userId: '00000000-0000-4000-8000-000000000003',
    clientId: 'open-clips-dev',
    scopes: ['destinations:read'],
  });
  const store: DelegatedAuthorizationStore = {
    findClient: vi.fn(),
    createGrantAndCode: vi.fn(),
    exchangeCode,
    rotateRefreshToken: vi.fn().mockResolvedValue(null),
    authenticateAccessToken: vi.fn(),
    revokeGrant: vi.fn(),
  };
  return { exchangeCode, service: new DelegatedAuthorizationService(store) };
}

describe('delegated authorization HTTP routes', () => {
  it('exchanges a valid authorization code using the OAuth token envelope', async () => {
    const application = Fastify();
    const { service } = buildService();
    registerDelegatedAuthorizationRoutes(application, service, {} as AuthService);

    const response = await application.inject({
      method: 'POST',
      url: '/connect/token',
      payload: {
        grant_type: 'authorization_code',
        code: 'opaque-code',
        client_id: 'open-clips-dev',
        redirect_uri: 'http://127.0.0.1/callback',
        code_verifier: 'v'.repeat(43),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    await application.close();
  });

  it('rejects malformed token requests without calling persistence', async () => {
    const application = Fastify();
    const { service, exchangeCode } = buildService();
    registerDelegatedAuthorizationRoutes(application, service, {} as AuthService);

    const response = await application.inject({
      method: 'POST',
      url: '/connect/token',
      payload: { grant_type: 'authorization_code' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Invalid token request',
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(exchangeCode).not.toHaveBeenCalled();
    await application.close();
  });

  it('uses a stable invalid_grant response for rejected refresh tokens', async () => {
    const application = Fastify();
    const { service } = buildService();
    registerDelegatedAuthorizationRoutes(application, service, {} as AuthService);

    const response = await application.inject({
      method: 'POST',
      url: '/connect/token',
      payload: { grant_type: 'refresh_token', refresh_token: 'expired' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'Refresh token is invalid or expired',
    });
    expect(response.headers['cache-control']).toBe('no-store');
    await application.close();
  });
});
