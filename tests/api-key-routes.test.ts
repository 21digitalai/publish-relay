import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it, vi } from 'vitest';

import { registerApiKeyRoutes } from '../src/modules/identity/api-key.routes.js';
import type { ApiKeyService } from '../src/modules/identity/api-key.service.js';
import { registerApiDocumentationRoute } from '../src/modules/api/openapi.js';
import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import type { AuthService } from '../src/modules/identity/auth.service.js';
import type { DelegatedAuthorizationService } from '../src/modules/delegated-authorization/delegated-authorization.service.js';

describe('API key HTTP boundary', () => {
  it('serves the versioned OpenAPI document', async () => {
    const application = Fastify();
    registerApiDocumentationRoute(application);
    const response = await application.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ openapi: '3.1.0' });
    const document = response.json<{
      paths: Record<
        string,
        {
          post?: {
            operationId: string;
            parameters: { name: string; required: boolean }[];
            responses: Record<string, unknown>;
          };
        }
      >;
    }>();
    const createPost = document.paths['/api/v1/posts']?.post;
    expect(createPost?.operationId).toBe('createPost');
    expect(createPost?.parameters).toContainEqual({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      schema: { type: 'string', minLength: 8, maxLength: 200 },
    });
    expect(createPost?.responses).toHaveProperty('201');
    expect(createPost?.responses).toHaveProperty('409');
  });

  it('returns the redacted account identity after expected-workspace preflight', async () => {
    const authenticate = vi.fn().mockResolvedValue({
      id: 'key-1',
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      workspaceLabel: 'Atlas',
      prefix: 'pr_public',
      capabilities: ['schedules:read'],
      expiresAt: null,
    });
    const application = Fastify();
    registerApiKeyRoutes(application, { authenticate } as unknown as ApiKeyService);
    const response = await application.inject({
      method: 'GET',
      url: '/api/v1/account',
      headers: {
        authorization: 'Bearer pr_public.secret',
        'x-publish-relay-workspace': 'workspace-1',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(authenticate).toHaveBeenCalledWith('workspace-1', 'pr_public.secret');
    const body = response.json<{ data: Record<string, unknown> }>();
    expect(body.data).not.toHaveProperty('secretHash');
    expect(body.data).not.toHaveProperty('createdByUserId');
  });

  it('rejects missing workspace preflight before authentication', async () => {
    const authenticate = vi.fn();
    const application = Fastify();
    registerApiKeyRoutes(application, { authenticate } as unknown as ApiKeyService);
    const response = await application.inject({
      method: 'GET',
      url: '/api/v1/account',
      headers: { authorization: 'Bearer pr_public.secret' },
    });
    expect(response.statusCode).toBe(401);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('returns an allowlisted delegated connection receipt without credential or user fields', async () => {
    const authenticateApiKey = vi.fn().mockResolvedValue(null);
    const authenticateDelegated = vi.fn().mockResolvedValue({
      grantId: '00000000-0000-4000-8000-000000000101',
      workspaceId: '00000000-0000-4000-8000-000000000102',
      workspaceLabel: 'Atlas',
      userId: '00000000-0000-4000-8000-000000000103',
      clientId: 'open-clips-dev',
      scopes: ['content:write', 'destinations:read'],
      accessExpiresAt: new Date('2026-09-10T17:00:00.000Z'),
    });
    const application = Fastify();
    registerApiKeyRoutes(
      application,
      { authenticate: authenticateApiKey } as unknown as ApiKeyService,
      undefined,
      undefined,
      { authenticate: authenticateDelegated } as unknown as DelegatedAuthorizationService,
    );
    const response = await application.inject({
      method: 'GET',
      url: '/api/v1/account',
      headers: {
        authorization: 'Bearer delegated-token',
        'x-publish-relay-workspace': '00000000-0000-4000-8000-000000000102',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      data: {
        principalType: 'delegated',
        clientId: 'open-clips-dev',
        grantId: '00000000-0000-4000-8000-000000000101',
        workspaceId: '00000000-0000-4000-8000-000000000102',
        workspaceLabel: 'Atlas',
        capabilities: ['content:write', 'destinations:read'],
        expiresAt: '2026-09-10T17:00:00.000Z',
      },
    });
    const data = response.json<{ data: Record<string, unknown> }>().data;
    expect(data).not.toHaveProperty('userId');
    expect(data).not.toHaveProperty('accessToken');
    expect(data).not.toHaveProperty('refreshToken');
  });

  it('rate limits an authenticated API key and returns bounded retry headers', async () => {
    const authenticate = vi.fn().mockResolvedValue({
      id: 'key-1',
      workspaceId: 'workspace-1',
      workspaceLabel: 'Atlas',
      prefix: 'pr_public',
      capabilities: [],
      expiresAt: null,
    });
    const application = Fastify();
    const limiter = new ApiRateLimiter({
      workspace: 1,
      key: 1,
      mutationWorkspace: 1,
      mutationKey: 1,
      windowMs: 60_000,
    });
    registerApiKeyRoutes(application, { authenticate } as unknown as ApiKeyService, limiter);
    const request = {
      method: 'GET' as const,
      url: '/api/v1/account',
      headers: {
        authorization: 'Bearer pr_public.secret',
        'x-publish-relay-workspace': 'workspace-1',
      },
    };
    expect((await application.inject(request)).statusCode).toBe(200);
    const limited = await application.inject(request);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers).toMatchObject({
      'x-ratelimit-limit': '1',
      'x-ratelimit-remaining': '0',
      'retry-after': '60',
    });
    expect(limited.json()).toMatchObject({
      success: false,
      error: { code: 'rate_limit_exceeded' },
    });
  });

  it('manages tenant API keys through session, role, CSRF, and one-time secret boundaries', async () => {
    const list = vi.fn().mockResolvedValue([
      {
        id: 'key-1',
        workspaceId: 'workspace-1',
        createdByUserId: 'user-1',
        createdByDisplayName: 'Mira',
        workspaceLabel: 'Atlas',
        label: 'Agent key',
        prefix: 'pr_public',
        capabilities: ['schedules:read'],
        expiresAt: null,
        createdAt: new Date('2026-09-01T00:00:00Z'),
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
    const create = vi.fn().mockResolvedValue({
      key: { id: 'key-2', prefix: 'pr_new' },
      token: 'pr_new.one-time-secret',
    });
    const revoke = vi.fn().mockResolvedValue(true);
    const authenticate = vi.fn().mockResolvedValue({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      role: 'owner',
    });
    const application = Fastify();
    await application.register(cookie);
    registerApiKeyRoutes(
      application,
      { list, create, revoke } as unknown as ApiKeyService,
      undefined,
      { authenticate } as unknown as AuthService,
    );
    const cookies =
      'publish_relay_session=workspace-1.session-token; publish_relay_csrf=csrf-token';

    const listed = await application.inject({
      method: 'GET',
      url: '/api/settings/api-keys',
      headers: { cookie: cookies },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.json()).not.toHaveProperty('data.items.0.secretHash');

    const rejected = await application.inject({
      method: 'POST',
      url: '/api/settings/api-keys',
      headers: { cookie: cookies },
      payload: { label: 'Agent key', capabilities: ['schedules:read'] },
    });
    expect(rejected.statusCode).toBe(403);

    const created = await application.inject({
      method: 'POST',
      url: '/api/settings/api-keys',
      headers: { cookie: cookies, 'x-csrf-token': 'csrf-token' },
      payload: { label: 'Agent key', capabilities: ['schedules:read'] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.json()).toMatchObject({ data: { token: 'pr_new.one-time-secret' } });

    const revoked = await application.inject({
      method: 'DELETE',
      url: '/api/settings/api-keys/00000000-0000-4000-8000-000000000001',
      headers: { cookie: cookies, 'x-csrf-token': 'csrf-token' },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-1', revokedByUserId: 'user-1' }),
    );
  });
});
