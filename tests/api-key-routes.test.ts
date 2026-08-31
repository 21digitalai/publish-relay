import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerApiKeyRoutes } from '../src/modules/identity/api-key.routes.js';
import type { ApiKeyService } from '../src/modules/identity/api-key.service.js';
import { registerApiDocumentationRoute } from '../src/modules/api/openapi.js';
import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';

describe('API key HTTP boundary', () => {
  it('serves the versioned OpenAPI document', async () => {
    const application = Fastify();
    registerApiDocumentationRoute(application);
    const response = await application.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ openapi: '3.1.0' });
  });

  it('returns the redacted account identity after expected-workspace preflight', async () => {
    const authenticate = vi.fn().mockResolvedValue({
      id: 'key-1',
      workspaceId: 'workspace-1',
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
});
