import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AuthService } from '../identity/auth.service.js';
import { authorizeRequest } from '../identity/auth.routes.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import type { ApiKeyService } from '../identity/api-key.service.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { errorEnvelope, successEnvelope } from '../api/contract.js';
import {
  isInstagramUnifiedConversationNoGo,
  listInstagramUnifiedConversationHistory,
  setInstagramUnifiedConversationNoGo,
} from './instagram-unified-no-go.repository.js';

const params = z.object({ accountId: z.uuid(), conversationId: z.string().min(1).max(256) });
const body = z.object({ blocked: z.boolean(), displayName: z.string().max(200).optional() });

export function registerInstagramUnifiedNoGoRoutes(
  application: FastifyInstance,
  database: NodePgDatabase,
  auth: AuthService,
) {
  application.get(
    '/api/provider-accounts/:accountId/instagram-unified-conversations/:conversationId/stop',
    async (request, reply) => {
      const identity = await authorizeRequest(request, auth, 'content:read');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      const parsed = params.safeParse(request.params);
      if (!parsed.success)
        return reply.code(400).send({ data: null, error: 'Invalid conversation' });
      return {
        data: {
          stopped: await isInstagramUnifiedConversationNoGo(database, {
            workspaceId: identity.workspaceId,
            ...parsed.data,
          }),
        },
        error: null,
      };
    },
  );
  application.put(
    '/api/provider-accounts/:accountId/instagram-unified-conversations/:conversationId/stop',
    async (request, reply) => {
      const identity = await authorizeRequest(request, auth, 'content:write');
      if (!identity || (identity.role !== 'owner' && identity.role !== 'admin'))
        return reply.code(identity ? 403 : 401).send({
          data: null,
          error: identity ? 'Workspace admin required' : 'Authentication required',
        });
      const path = params.safeParse(request.params);
      const parsed = body.safeParse(request.body);
      if (!path.success || !parsed.success)
        return reply.code(400).send({ data: null, error: 'Invalid conversation stop request' });
      const result = await setInstagramUnifiedConversationNoGo(database, {
        workspaceId: identity.workspaceId,
        ...path.data,
        blocked: parsed.data.blocked,
        ...(parsed.data.displayName === undefined ? {} : { displayName: parsed.data.displayName }),
      });
      return { data: { stopped: parsed.data.blocked, ...(result ?? {}) }, error: null };
    },
  );
  application.get(
    '/api/provider-accounts/:accountId/instagram-unified-conversations/:conversationId/history',
    async (request, reply) => {
      const identity = await authorizeRequest(request, auth, 'content:read');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      const path = params.safeParse(request.params);
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
        .safeParse(request.query);
      if (!path.success || !query.success)
        return reply.code(400).send({ data: null, error: 'Invalid history request' });
      const items = await listInstagramUnifiedConversationHistory(database, {
        workspaceId: identity.workspaceId,
        ...path.data,
        ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
      });
      return {
        data: {
          items: items.map((item) => ({
            ...item,
            createdAt: item.createdAt.toISOString(),
            updatedAt: item.updatedAt.toISOString(),
          })),
        },
        error: null,
      };
    },
  );
}

export function registerInstagramUnifiedNoGoApiRoutes(
  application: FastifyInstance,
  database: NodePgDatabase,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
) {
  const authorize = (
    request: Parameters<typeof authorizeMachineRequest>[0],
    capability: 'destinations:read' | 'dms:send',
  ) => authorizeMachineRequest(request, apiKeys, delegatedAuthorization, capability);
  application.get(
    '/api/v1/destinations/:accountId/instagram-unified-conversations/:conversationId/stop',
    async (request, reply) => {
      const path = params.safeParse(request.params);
      if (!path.success)
        return reply
          .code(400)
          .send(errorEnvelope('invalid_request', 'Invalid conversation', request.id));
      try {
        const principal = await authorize(request, 'destinations:read');
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const limit = rateLimiter.check(principal.workspaceId, principal.actorId, 'read');
        if (!limit.allowed)
          return await reply
            .code(429)
            .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        return await reply.send(
          successEnvelope(
            {
              stopped: await isInstagramUnifiedConversationNoGo(database, {
                workspaceId: principal.workspaceId,
                ...path.data,
              }),
            },
            request.id,
          ),
        );
      } catch (error) {
        if (error instanceof MachineAuthorizationError)
          return reply.code(403).send(errorEnvelope(error.code, 'Access denied', request.id));
        throw error;
      }
    },
  );
  application.put(
    '/api/v1/destinations/:accountId/instagram-unified-conversations/:conversationId/stop',
    async (request, reply) => {
      const path = params.safeParse(request.params);
      const parsed = body.safeParse(request.body);
      if (!path.success || !parsed.success)
        return reply
          .code(400)
          .send(errorEnvelope('invalid_request', 'Invalid conversation stop request', request.id));
      try {
        const principal = await authorize(request, 'dms:send');
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const limit = rateLimiter.check(principal.workspaceId, principal.actorId, 'mutation');
        if (!limit.allowed)
          return await reply
            .code(429)
            .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        const result = await setInstagramUnifiedConversationNoGo(database, {
          workspaceId: principal.workspaceId,
          ...path.data,
          blocked: parsed.data.blocked,
          ...(parsed.data.displayName === undefined
            ? {}
            : { displayName: parsed.data.displayName }),
        });
        return await reply.send(
          successEnvelope({ stopped: parsed.data.blocked, ...(result ?? {}) }, request.id),
        );
      } catch (error) {
        if (error instanceof MachineAuthorizationError)
          return reply.code(403).send(errorEnvelope(error.code, 'Access denied', request.id));
        throw error;
      }
    },
  );
  application.get(
    '/api/v1/destinations/:accountId/instagram-unified-conversations/:conversationId/history',
    async (request, reply) => {
      const path = params.safeParse(request.params);
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
        .safeParse(request.query);
      if (!path.success || !query.success)
        return reply
          .code(400)
          .send(errorEnvelope('invalid_request', 'Invalid history request', request.id));
      const principal = await authorize(request, 'destinations:read');
      if (!principal)
        return reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      const items = await listInstagramUnifiedConversationHistory(database, {
        workspaceId: principal.workspaceId,
        ...path.data,
        ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
      });
      return reply.send(
        successEnvelope(
          {
            items: items.map((item) => ({
              ...item,
              createdAt: item.createdAt.toISOString(),
              updatedAt: item.updatedAt.toISOString(),
            })),
          },
          request.id,
        ),
      );
    },
  );
}
