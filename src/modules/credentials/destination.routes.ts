import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import { authorizeApiKeyRequest } from '../identity/api-key.routes.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import { listProviderAccounts } from './provider-account.service.js';

export function registerDestinationRoutes(
  application: FastifyInstance,
  database: NodePgDatabase,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
): void {
  application.get('/api/v1/destinations', async (request, reply) => {
    try {
      const principal = await authorizeApiKeyRequest(request, apiKeys, 'destinations:read');
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      const decision = rateLimiter.check(principal.workspaceId, principal.id, 'read');
      void reply.header('X-RateLimit-Limit', decision.limit);
      void reply.header('X-RateLimit-Remaining', decision.remaining);
      if (!decision.allowed) {
        void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
        return await reply
          .code(429)
          .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
      }
      const accounts = await listProviderAccounts(database, principal.workspaceId);
      return await reply.send(
        successEnvelope(
          {
            items: accounts.map((account) => ({
              id: account.id,
              provider: account.provider,
              displayName: account.displayName,
              status: account.status,
              updatedAt: account.updatedAt.toISOString(),
            })),
          },
          request.id,
        ),
      );
    } catch (error) {
      if (error instanceof ApiKeyAuthorizationError)
        return await reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
      throw error;
    }
  });
}
