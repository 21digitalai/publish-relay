import type { FastifyInstance, FastifyRequest } from 'fastify';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import type { ApiKeyCapability } from './api-key.js';
import type { ApiKeyPrincipal, ApiKeyService } from './api-key.service.js';

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

export function registerApiKeyRoutes(application: FastifyInstance, service: ApiKeyService): void {
  application.get('/api/v1/account', async (request, reply) => {
    const principal = await authorizeApiKeyRequest(request, service);
    if (!principal)
      return reply
        .code(401)
        .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
    return successEnvelope(principal, request.id);
  });
}
