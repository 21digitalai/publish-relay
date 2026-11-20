import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import {
  InvalidAccountPageCursorError,
  listProviderAccountsPage,
  availableWithTikTokRuntime,
} from './provider-account.service.js';
import type { MasterKeyProvider } from './envelope.js';
import type { TikTokHttpClient } from '../providers/tiktok-http-client.js';
import { TikTokRequestError } from '../providers/tiktok-http-client.js';
import {
  fetchTikTokCapabilitySnapshot,
  TikTokCapabilityUnavailableError,
} from '../providers/tiktok-capabilities.service.js';
import { z } from 'zod';

const capabilityParams = z.object({ accountId: z.uuid() });
const destinationQuery = z.object({ cursor: z.string().min(1).max(1024).optional() });

export function registerDestinationRoutes(
  application: FastifyInstance,
  database: NodePgDatabase,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
  tiktok?: { keys: MasterKeyProvider; client: TikTokHttpClient },
  enabledAdapters?: ReadonlySet<string>,
): void {
  application.get('/api/v1/destinations/:accountId/tiktok-capabilities', async (request, reply) => {
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
      const params = capabilityParams.safeParse(request.params);
      if (!params.success)
        return await reply
          .code(400)
          .send(errorEnvelope('invalid_destination', 'Invalid destination', request.id));
      const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'read');
      if (!decision.allowed) {
        void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
        return await reply
          .code(429)
          .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
      }
      if (!tiktok)
        return await reply
          .code(503)
          .send(
            errorEnvelope(
              'provider_unavailable',
              'TikTok capability lookup is unavailable',
              request.id,
            ),
          );
      const snapshot = await fetchTikTokCapabilitySnapshot(database, tiktok.keys, tiktok.client, {
        workspaceId: principal.workspaceId,
        accountId: params.data.accountId,
        requestId: request.id,
      });
      return await reply.send(successEnvelope(snapshot, request.id));
    } catch (error) {
      if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
        return await reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
      if (error instanceof TikTokCapabilityUnavailableError)
        return await reply
          .code(409)
          .send(errorEnvelope('destination_unavailable', error.message, request.id));
      if (error instanceof TikTokRequestError) {
        const status = error.kind === 'rate_limit' ? 429 : error.kind === 'auth' ? 409 : 502;
        if (error.retryAfterSeconds !== undefined)
          void reply.header('Retry-After', error.retryAfterSeconds);
        return await reply
          .code(status)
          .send(
            errorEnvelope(
              'provider_lookup_failed',
              'TikTok capability lookup failed; retry or reconnect the account',
              request.id,
            ),
          );
      }
      throw error;
    }
  });
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
      const query = destinationQuery.safeParse(request.query);
      if (!query.success)
        return await reply
          .code(400)
          .send(errorEnvelope('invalid_cursor', 'Invalid destination page cursor', request.id));
      const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'read');
      void reply.header('X-RateLimit-Limit', decision.limit);
      void reply.header('X-RateLimit-Remaining', decision.remaining);
      if (!decision.allowed) {
        void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
        return await reply
          .code(429)
          .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
      }
      const page = await listProviderAccountsPage(
        database,
        principal.workspaceId,
        undefined,
        query.data.cursor,
        undefined,
        { type: principal.kind, id: principal.actorId, capability: 'destinations:read' },
      );
      return await reply.send(
        successEnvelope(
          {
            items: page.accounts
              .filter((item) => enabledAdapters?.has(item.destinationProvider) !== false)
              .map((item) => {
                const account = availableWithTikTokRuntime(item, Boolean(tiktok));
                return {
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
                };
              }),
            nextCursor: page.nextCursor,
          },
          request.id,
        ),
      );
    } catch (error) {
      if (error instanceof InvalidAccountPageCursorError)
        return await reply
          .code(400)
          .send(errorEnvelope('invalid_cursor', error.message, request.id));
      if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
        return await reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
      throw error;
    }
  });
}
