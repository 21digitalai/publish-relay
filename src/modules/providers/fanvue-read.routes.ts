import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import type { ApiKeyCapability } from '../identity/api-key.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import { FanvueRequestError } from './fanvue-http-client.js';
import { FanvueReadUnavailableError, type FanvueReadService } from './fanvue-read.service.js';

const paramsSchema = z.object({ accountId: z.uuid(), fanUuid: z.uuid().optional(), mediaUuid: z.uuid().optional() });
const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  size: z.coerce.number().int().min(1).max(50).optional(),
  unreadOnly: z.enum(['true', 'false']).optional(),
});

interface ReadInput { workspaceId: string; accountId: string; page?: number; size?: number; unreadOnly?: boolean; fanUuid?: string; mediaUuid?: string }

export function registerFanvueReadRoutes(
  application: FastifyInstance,
  service: FanvueReadService,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
): void {
  const routes: {
    path: string;
    capability: ApiKeyCapability;
    read: (input: ReadInput) => Promise<unknown>;
  }[] = [
    { path: '/api/v1/fanvue/accounts/:accountId/chats', capability: 'fanvue:chats:read', read: (input) => service.listChats(input) },
    { path: '/api/v1/fanvue/accounts/:accountId/chats/:fanUuid/messages', capability: 'fanvue:chats:read', read: (input) => service.listMessages({ ...input, fanUuid: requiredId(input.fanUuid) }) },
    { path: '/api/v1/fanvue/accounts/:accountId/media', capability: 'fanvue:media:read', read: (input) => service.listMedia(input) },
    { path: '/api/v1/fanvue/accounts/:accountId/media/:mediaUuid', capability: 'fanvue:media:read', read: (input) => service.getMediaStatus({ ...input, mediaUuid: requiredId(input.mediaUuid) }) },
  ];
  for (const route of routes) {
    application.get(route.path, async (request, reply) => {
      try {
        const principal = await authorizeMachineRequest(request, apiKeys, delegatedAuthorization, route.capability);
        if (!principal)
          return await reply.code(401).send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const params = paramsSchema.safeParse(request.params);
        const query = querySchema.safeParse(request.query);
        if (!params.success || !query.success)
          return await reply.code(400).send(errorEnvelope('invalid_request', 'Invalid Fanvue read request', request.id));
        const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'read');
        if (!decision.allowed) {
          void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
          return await reply.code(429).send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        }
        const data = await route.read({
          workspaceId: principal.workspaceId,
          accountId: params.data.accountId,
          ...(params.data.fanUuid ? { fanUuid: params.data.fanUuid } : {}),
          ...(params.data.mediaUuid ? { mediaUuid: params.data.mediaUuid } : {}),
          ...(query.data.page === undefined ? {} : { page: query.data.page }),
          ...(query.data.size === undefined ? {} : { size: query.data.size }),
          unreadOnly: query.data.unreadOnly === 'true',
        });
        return await reply.send(successEnvelope(data, request.id));
      } catch (error) {
        return sendReadError(error, request, reply);
      }
    });
  }
}

function requiredId(id: string | undefined): string {
  if (!id) throw new Error('Missing validated Fanvue resource ID');
  return id;
}

function sendReadError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
    return reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
  if (error instanceof FanvueReadUnavailableError) {
    const missing = error.reason === 'account_not_found';
    return reply.code(missing ? 404 : 409).send(errorEnvelope(error.reason, error.message, request.id));
  }
  if (error instanceof FanvueRequestError) {
    const status = error.status === 429 ? 429 : error.status === 401 || error.status === 403 ? 409 : 502;
    return reply.code(status).send(errorEnvelope('provider_read_failed', 'Fanvue read failed; retry or reconnect the account', request.id));
  }
  throw error;
}
