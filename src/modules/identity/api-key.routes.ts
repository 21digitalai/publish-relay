import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { ApiKeyCapability } from './api-key.js';
import type { ApiKeyPrincipal, ApiKeyService } from './api-key.service.js';
import type { AuthService } from './auth.service.js';
import { authorizeRequest, CSRF_COOKIE } from './auth.routes.js';
import { verifyCsrfToken } from './session.js';

const createKeySchema = z.object({
  label: z.string().trim().min(1).max(100),
  capabilities: z.array(z.string()).min(1),
  expiresAt: z.iso.datetime().nullable().optional(),
});
const keyParamsSchema = z.object({ keyId: z.uuid() });

function hasValidCsrf(request: FastifyRequest): boolean {
  return verifyCsrfToken(
    request.cookies[CSRF_COOKIE],
    request.headers['x-csrf-token'] as string | undefined,
  );
}

function readBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  return token || null;
}

export async function authorizeApiKeyRequest(
  request: FastifyRequest,
  service: ApiKeyService,
  requiredCapability?: ApiKeyCapability,
): Promise<ApiKeyPrincipal | null> {
  const workspaceId = request.headers['x-publish-relay-workspace'];
  const token = readBearerToken(request);
  if (typeof workspaceId !== 'string' || !workspaceId || !token) return null;
  const principal = await service.authenticate(workspaceId, token);
  if (!principal) return null;
  if (requiredCapability)
    await service.requireCapability(principal, requiredCapability, request.id);
  return principal;
}

export function registerApiKeyRoutes(
  application: FastifyInstance,
  service: ApiKeyService,
  rateLimiter?: ApiRateLimiter,
  auth?: AuthService,
): void {
  application.get('/api/v1/account', async (request, reply) => {
    const principal = await authorizeApiKeyRequest(request, service);
    if (!principal)
      return reply
        .code(401)
        .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
    const decision = rateLimiter?.check(principal.workspaceId, principal.id, 'read');
    if (decision) {
      void reply.header('X-RateLimit-Limit', decision.limit);
      void reply.header('X-RateLimit-Remaining', decision.remaining);
      if (!decision.allowed) {
        void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
        return reply
          .code(429)
          .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
      }
    }
    return successEnvelope(
      {
        id: principal.id,
        workspaceId: principal.workspaceId,
        workspaceLabel: principal.workspaceLabel,
        prefix: principal.prefix,
        capabilities: principal.capabilities,
        expiresAt: principal.expiresAt,
      },
      request.id,
    );
  });

  if (!auth) return;

  application.get('/api/settings/api-keys', async (request, reply) => {
    const identity = await authorizeRequest(request, auth, 'workspace:manage');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    void reply.header('Cache-Control', 'no-store');
    return {
      data: { items: await service.list(identity.workspaceId, identity.userId) },
      error: null,
    };
  });

  application.post('/api/settings/api-keys', async (request, reply) => {
    const identity = await authorizeRequest(request, auth, 'workspace:manage');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!hasValidCsrf(request))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const input = createKeySchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ data: null, error: 'Invalid API key' });
    const created = await service.create({
      workspaceId: identity.workspaceId,
      createdByUserId: identity.userId,
      label: input.data.label,
      capabilities: input.data.capabilities,
      expiresAt: input.data.expiresAt ? new Date(input.data.expiresAt) : null,
      requestId: request.id,
    });
    void reply.header('Cache-Control', 'no-store');
    return reply.code(201).send({ data: created, error: null });
  });

  application.delete('/api/settings/api-keys/:keyId', async (request, reply) => {
    const identity = await authorizeRequest(request, auth, 'workspace:manage');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!hasValidCsrf(request))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const input = keyParamsSchema.safeParse(request.params);
    if (!input.success) return reply.code(404).send({ data: null, error: 'API key not found' });
    const revoked = await service.revoke({
      workspaceId: identity.workspaceId,
      keyId: input.data.keyId,
      revokedByUserId: identity.userId,
      requestId: request.id,
    });
    return revoked
      ? { data: { revoked: true }, error: null }
      : reply.code(404).send({ data: null, error: 'API key not found' });
  });
}
