import cookie from '@fastify/cookie';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/identity/auth.routes.js', () => ({
  authenticateRequest: vi.fn(),
  CSRF_COOKIE: 'publish_relay_csrf',
}));

import { registerDelegatedAuthorizationRoutes } from '../src/modules/delegated-authorization/delegated-authorization.routes.js';
import {
  DelegatedAuthorizationService,
  type DelegatedAuthorizationStore,
} from '../src/modules/delegated-authorization/delegated-authorization.service.js';
import type { AuthService } from '../src/modules/identity/auth.service.js';
import { authenticateRequest } from '../src/modules/identity/auth.routes.js';

const redirectUri = 'http://127.0.0.1/callback';
const client = {
  id: 'open-clips-dev',
  redirectUris: [redirectUri],
  allowedScopes: ['destinations:read', 'schedules:read'],
};
const identity = {
  workspaceId: '00000000-0000-4000-8000-000000000002',
  userId: '00000000-0000-4000-8000-000000000003',
};
const grantId = '00000000-0000-4000-8000-000000000001';
const authorizationQuery = new URLSearchParams({
  client_id: client.id,
  redirect_uri: redirectUri,
  state: 'opaque-state',
  code_challenge: 'c'.repeat(43),
  code_challenge_method: 'S256',
  scope: 'destinations:read schedules:read destinations:read',
});

function buildService(confidential = false) {
  const exchangeCode = vi.fn().mockResolvedValue({
    grantId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    userId: '00000000-0000-4000-8000-000000000003',
    clientId: 'open-clips-dev',
    scopes: ['destinations:read'],
  });
  const createGrantAndCode = vi.fn().mockResolvedValue(undefined);
  const listGrants = vi.fn().mockResolvedValue([
    {
      id: grantId,
      clientId: client.id,
      scopes: ['destinations:read'],
      createdAt: new Date('2026-09-10T10:00:00.000Z'),
    },
  ]);
  const revokeGrant = vi.fn().mockResolvedValue(true);
  const revokeByToken = vi.fn().mockResolvedValue(undefined);
  const store: DelegatedAuthorizationStore = {
    findClient: vi.fn().mockImplementation((clientId) =>
      Promise.resolve(
        clientId === client.id
          ? {
              ...client,
              ...(confidential
                ? {
                    clientType: 'confidential' as const,
                    secretHash: createHash('sha256').update('correct-secret').digest('hex'),
                  }
                : { clientType: 'public' as const }),
            }
          : null,
      ),
    ),
    createGrantAndCode,
    exchangeCode,
    rotateRefreshToken: vi.fn().mockResolvedValue(null),
    authenticateAccessToken: vi.fn(),
    listGrants,
    revokeGrant,
    revokeByToken,
  };
  return {
    createGrantAndCode,
    exchangeCode,
    listGrants,
    revokeGrant,
    revokeByToken,
    service: new DelegatedAuthorizationService(store),
  };
}

async function buildApplication(shellHtml?: string, confidential = false) {
  const application = Fastify();
  await application.register(cookie);
  const built = buildService(confidential);
  registerDelegatedAuthorizationRoutes(application, built.service, {} as AuthService, shellHtml);
  return { application, ...built };
}

describe('delegated authorization HTTP routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequest).mockResolvedValue(identity as never);
  });

  it('revokes a delegated token family with an opaque no-store response', async () => {
    const { application, revokeByToken } = await buildApplication();
    const response = await application.inject({
      method: 'POST',
      url: '/connect/revoke',
      payload: { token: 'refresh-secret', client_id: 'open-clips-dev' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(revokeByToken).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(revokeByToken).mock.calls)).not.toContain('refresh-secret');
    await application.close();
  });

  it('rejects missing and wrong confidential secrets and accepts the correct secret', async () => {
    const { application, revokeByToken } = await buildApplication(undefined, true);
    for (const payload of [
      { token: 'refresh-secret', client_id: client.id },
      { token: 'refresh-secret', client_id: client.id, client_secret: 'wrong' },
    ]) {
      const response = await application.inject({
        method: 'POST',
        url: '/connect/revoke',
        payload,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'invalid_client' });
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(revokeByToken).not.toHaveBeenCalled();

    const accepted = await application.inject({
      method: 'POST',
      url: '/connect/revoke',
      payload: { token: 'refresh-secret', client_id: client.id, client_secret: 'correct-secret' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(revokeByToken).toHaveBeenCalledOnce();
    await application.close();
  });

  it('returns a bounded tenant grant summary without token material', async () => {
    const { application, listGrants } = await buildApplication();
    const response = await application.inject({
      method: 'GET',
      url: '/api/settings/delegated-grants',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [
        {
          id: grantId,
          clientId: client.id,
          scopes: ['destinations:read'],
          createdAt: '2026-09-10T10:00:00.000Z',
        },
      ],
      error: null,
    });
    expect(listGrants).toHaveBeenCalledWith(identity.workspaceId, identity.userId);
    expect(response.body).not.toMatch(/token|secret|userId|workspaceId/);
    await application.close();
  });

  it('requires login before inspecting an authorization request', async () => {
    const { application } = await buildApplication();
    vi.mocked(authenticateRequest).mockResolvedValueOnce(null);

    const response = await application.inject({
      method: 'GET',
      url: `/connect/authorize?${authorizationQuery}`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ data: null, error: { code: 'login_required' } });
    await application.close();
  });

  it('serves the consent shell to browsers and preserves login continuation', async () => {
    const { application } = await buildApplication('<main>consent shell</main>');
    const rendered = await application.inject({
      method: 'GET',
      url: `/connect/authorize?${authorizationQuery}`,
      headers: { accept: 'text/html' },
    });
    expect(rendered.statusCode).toBe(200);
    expect(rendered.headers['content-type']).toContain('text/html');
    expect(rendered.body).toContain('consent shell');

    vi.mocked(authenticateRequest).mockResolvedValueOnce(null);
    const login = await application.inject({
      method: 'GET',
      url: `/connect/authorize?${authorizationQuery}`,
      headers: { accept: 'text/html' },
    });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toContain('/login?next=');
    expect(decodeURIComponent(login.headers.location ?? '')).toContain('/connect/authorize?');
    await application.close();
  });

  it('rejects malformed and unregistered authorization requests', async () => {
    const { application } = await buildApplication();
    const malformed = await application.inject({ method: 'GET', url: '/connect/authorize' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ data: null, error: { code: 'invalid_request' } });

    const unregistered = new URLSearchParams(authorizationQuery);
    unregistered.set('client_id', 'unknown-client');
    const rejected = await application.inject({
      method: 'GET',
      url: `/connect/authorize?${unregistered}`,
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toMatchObject({ data: null, error: { code: 'invalid_client' } });
    await application.close();
  });

  it('returns only the authenticated consent projection', async () => {
    const { application } = await buildApplication();
    const response = await application.inject({
      method: 'GET',
      url: `/connect/authorize?${authorizationQuery}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        client: { id: client.id },
        workspaceId: identity.workspaceId,
        scopes: ['destinations:read', 'schedules:read'],
        state: 'opaque-state',
      },
      error: null,
    });
    expect(response.body).not.toContain('redirectUris');
    expect(response.body).not.toContain('allowedScopes');
    await application.close();
  });

  it('enforces CSRF and redirects successful approval only to the registered callback', async () => {
    const { application, createGrantAndCode } = await buildApplication();
    const payload = Object.fromEntries(authorizationQuery);
    const denied = await application.inject({ method: 'POST', url: '/connect/authorize', payload });
    expect(denied.statusCode).toBe(403);
    expect(createGrantAndCode).not.toHaveBeenCalled();

    const approved = await application.inject({
      method: 'POST',
      url: '/connect/authorize',
      headers: {
        cookie: 'publish_relay_csrf=csrf-token',
        'x-csrf-token': 'csrf-token',
      },
      payload,
    });
    expect(approved.statusCode).toBe(302);
    const location = approved.headers.location;
    if (!location) throw new Error('Approved authorization response must include a redirect');
    const redirect = new URL(location);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(redirectUri);
    expect([...redirect.searchParams.keys()].sort()).toEqual(['code', 'state']);
    expect(redirect.searchParams.get('code')).toHaveLength(43);
    expect(redirect.searchParams.get('state')).toBe('opaque-state');
    expect(approved.headers['cache-control']).toBe('no-store');
    await application.close();
  });

  it('maps approval protocol failures without redirecting', async () => {
    const { application, createGrantAndCode } = await buildApplication();
    const payload = Object.fromEntries(authorizationQuery);
    payload.scope = 'forbidden:scope';
    const response = await application.inject({
      method: 'POST',
      url: '/connect/authorize',
      headers: {
        cookie: 'publish_relay_csrf=csrf-token',
        'x-csrf-token': 'csrf-token',
      },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ data: null, error: { code: 'invalid_scope' } });
    expect(response.headers.location).toBeUndefined();
    expect(createGrantAndCode).not.toHaveBeenCalled();
    await application.close();
  });

  it('keeps grant revocation tenant-bound and returns safe not-found responses', async () => {
    const { application, revokeGrant } = await buildApplication();
    revokeGrant.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const headers = {
      cookie: 'publish_relay_csrf=csrf-token',
      'x-csrf-token': 'csrf-token',
    };
    const missing = await application.inject({
      method: 'DELETE',
      url: `/api/settings/delegated-grants/${grantId}`,
      headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ data: null, error: 'Grant not found' });
    expect(revokeGrant).toHaveBeenNthCalledWith(
      1,
      identity.workspaceId,
      identity.userId,
      grantId,
      expect.any(Date),
      expect.any(String),
    );

    const revoked = await application.inject({
      method: 'DELETE',
      url: `/api/settings/delegated-grants/${grantId}`,
      headers,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ data: { revoked: true }, error: null });
    await application.close();
  });

  it('exchanges a valid authorization code using the OAuth token envelope', async () => {
    const { application } = await buildApplication();

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
    const { application, exchangeCode } = await buildApplication();

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
    const { application } = await buildApplication();

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
