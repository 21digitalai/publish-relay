import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import { listProviderAccounts } from './provider-account.service.js';

export function registerDestinationRoutes(
  application: FastifyInstance,
  database: NodePgDatabase,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
): void {
  application.get('/api/v1/destinations', async (request, reply) => {
    try {
      const principal = await authorizeMachineRequest(
        request,
        apiKeys,
        delegatedAuthorization,
        'destinations:read',
      );
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'read');
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
              destinationProvider: account.destinationProvider,
              displayName: account.displayName,
              status: account.status,
              availability: account.availability,
              remoteParentAccountId: account.remoteParentAccountId,
              capabilitySnapshot: account.capabilitySnapshot,
              capabilitiesCheckedAt: account.capabilitiesCheckedAt?.toISOString() ?? null,
              capabilityFreshness: account.capabilityFreshness,
              updatedAt: account.updatedAt.toISOString(),
            })),
          },
          request.id,
        ),
      );
    } catch (error) {
      if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
        return await reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
      throw error;
    }
  });
}
