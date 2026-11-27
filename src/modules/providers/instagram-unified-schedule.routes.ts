import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import type { AuthService } from '../identity/auth.service.js';
import { authorizeRequest } from '../identity/auth.routes.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { ApiKeyService } from '../identity/api-key.service.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import { errorEnvelope, successEnvelope } from '../api/contract.js';
import type { InstagramUnifiedReadClient } from './instagram-unified-read-client.js';
import {
  createInstagramUnifiedScheduleService,
  InstagramUnifiedPendingConflictError,
} from './instagram-unified-schedule.service.js';
import { InstagramUnifiedEligibilityError } from './instagram-unified-send.service.js';

const params = z.strictObject({ accountId: z.uuid(), intentId: z.uuid().optional() });
const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z
    .enum(['pending', 'claimed', 'cancelled', 'confirmed', 'failed', 'unknown', 'expired'])
    .optional(),
});
const body = z.strictObject({
  clientActionId: z.uuid(),
  kind: z.enum(['comment_reply', 'dm_reply']),
  targetId: z.string().min(1).max(256),
  parentId: z.string().min(1).max(256),
  recipientId: z.string().min(1).max(256).optional(),
  text: z.string().trim().min(1).max(2000),
  dueAt: z.iso.datetime({ offset: true }),
});

export function registerInstagramUnifiedScheduleRoutes(
  application: FastifyInstance,
  runtime: {
    database: NodePgDatabase;
    keys: MasterKeyProvider;
    client: InstagramUnifiedReadClient;
  },
  auth: AuthService,
) {
  const service = createInstagramUnifiedScheduleService(runtime);
  application.post(
    '/api/provider-accounts/:accountId/instagram-unified-schedules',
    async (request, reply) => {
      const identity = await authorizeRequest(request, auth, 'content:write');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      const path = params.pick({ accountId: true }).safeParse(request.params);
      const parsed = body.safeParse(request.body);
      if (!path.success || !parsed.success)
        return reply.code(400).send({ data: null, error: 'Invalid Unified Instagram schedule' });
      try {
        return await reply.code(202).send({
          data: await service.schedule({
            ...parsed.data,
            accountId: path.data.accountId,
            workspaceId: identity.workspaceId,
            actor: { type: 'user', id: identity.userId },
          }),
          error: null,
        });
      } catch (error) {
        if (error instanceof InstagramUnifiedPendingConflictError)
          return reply.code(409).send({ data: null, error: error.message });
        if (error instanceof InstagramUnifiedEligibilityError)
          return reply.code(409).send({
            data: null,
            error: 'Unified Instagram reply is not currently eligible for scheduling',
          });
        throw error;
      }
    },
  );
  application.get(
    '/api/provider-accounts/:accountId/instagram-unified-schedules/:intentId',
    async (request, reply) => {
      const identity = await authorizeRequest(request, auth, 'content:read');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      const path = params.safeParse(request.params);
      if (!path.success || !path.data.intentId)
        return reply.code(400).send({ data: null, error: 'Invalid intent' });
      const result = await service.get({
        workspaceId: identity.workspaceId,
        accountId: path.data.accountId,
        id: path.data.intentId,
      });
      return result
        ? reply.send({ data: present(result), error: null })
        : reply.code(404).send({ data: null, error: 'Intent not found' });
    },
  );
  application.get(
    '/api/provider-accounts/:accountId/instagram-unified-schedules',
    async (request, reply) => {
      const identity = await authorizeRequest(request, auth, 'content:read');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      const path = params.pick({ accountId: true }).safeParse(request.params);
      const query = listQuery.safeParse(request.query);
      if (!path.success || !query.success)
        return reply.code(400).send({ data: null, error: 'Invalid schedule query' });
      const result = await service.list({
        workspaceId: identity.workspaceId,
        accountId: path.data.accountId,
        ...query.data,
      });
      return reply.send({
        data: { items: result.rows.map(present), hasMore: result.hasMore },
        error: null,
      });
    },
  );
  application.delete(
    '/api/provider-accounts/:accountId/instagram-unified-schedules/:intentId',
    async (request, reply) => {
      const identity = await authorizeRequest(request, auth, 'content:write');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      const path = params.safeParse(request.params);
      if (!path.success || !path.data.intentId)
        return reply.code(400).send({ data: null, error: 'Invalid intent' });
      const cancelled = await service.cancel({
        workspaceId: identity.workspaceId,
        accountId: path.data.accountId,
        id: path.data.intentId,
      });
      return cancelled
        ? reply.send({ data: { id: path.data.intentId, status: 'cancelled' }, error: null })
        : reply.code(409).send({ data: null, error: 'Intent is not pending' });
    },
  );
}

export function registerInstagramUnifiedScheduleApiRoutes(
  application: FastifyInstance,
  runtime: {
    database: NodePgDatabase;
    keys: MasterKeyProvider;
    client: InstagramUnifiedReadClient;
  },
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
) {
  const service = createInstagramUnifiedScheduleService(runtime);
  const accountParams = z.strictObject({ accountId: z.uuid() });
  const intentParams = z.strictObject({ accountId: z.uuid(), intentId: z.uuid() });
  const authorize = (
    request: Parameters<typeof authorizeMachineRequest>[0],
    capability: 'schedules:read' | 'schedules:write',
  ) => authorizeMachineRequest(request, apiKeys, delegatedAuthorization, capability);

  application.post(
    '/api/v1/destinations/:accountId/instagram-unified-schedules',
    async (request, reply) => {
      const path = accountParams.safeParse(request.params);
      const parsed = body.safeParse(request.body);
      if (!path.success || !parsed.success)
        return reply
          .code(400)
          .send(errorEnvelope('invalid_request', 'Invalid Unified Instagram schedule', request.id));
      try {
        const principal = await authorize(request, 'schedules:write');
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const limit = rateLimiter.check(principal.workspaceId, principal.actorId, 'mutation');
        if (!limit.allowed)
          return await reply
            .code(429)
            .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        const result = await service.schedule({
          ...parsed.data,
          accountId: path.data.accountId,
          workspaceId: principal.workspaceId,
          actor: { type: principal.kind, id: principal.actorId },
        });
        return await reply.code(202).send(successEnvelope(result, request.id));
      } catch (error) {
        if (error instanceof MachineAuthorizationError)
          return await reply
            .code(403)
            .send(
              errorEnvelope(error.code, 'Unified Instagram schedule access denied', request.id),
            );
        if (error instanceof InstagramUnifiedPendingConflictError)
          return await reply
            .code(409)
            .send(errorEnvelope('action_conflict', error.message, request.id));
        if (error instanceof InstagramUnifiedEligibilityError)
          return await reply
            .code(409)
            .send(
              errorEnvelope(
                'not_eligible',
                'Unified Instagram reply is not currently eligible for scheduling',
                request.id,
              ),
            );
        throw error;
      }
    },
  );

  application.get(
    '/api/v1/destinations/:accountId/instagram-unified-schedules',
    async (request, reply) => {
      const path = accountParams.safeParse(request.params);
      const query = listQuery.safeParse(request.query);
      if (!path.success || !query.success)
        return reply
          .code(400)
          .send(
            errorEnvelope(
              'invalid_request',
              'Invalid Unified Instagram schedule query',
              request.id,
            ),
          );
      try {
        const principal = await authorize(request, 'schedules:read');
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const limit = rateLimiter.check(principal.workspaceId, principal.actorId, 'read');
        if (!limit.allowed)
          return await reply
            .code(429)
            .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        const result = await service.list({
          workspaceId: principal.workspaceId,
          accountId: path.data.accountId,
          ...query.data,
        });
        return await reply.send(
          successEnvelope({ items: result.rows.map(present), hasMore: result.hasMore }, request.id),
        );
      } catch (error) {
        if (error instanceof MachineAuthorizationError)
          return await reply
            .code(403)
            .send(
              errorEnvelope(error.code, 'Unified Instagram schedule access denied', request.id),
            );
        throw error;
      }
    },
  );

  application.get(
    '/api/v1/destinations/:accountId/instagram-unified-schedules/:intentId',
    async (request, reply) => {
      const path = intentParams.safeParse(request.params);
      if (!path.success)
        return reply
          .code(400)
          .send(errorEnvelope('invalid_request', 'Invalid Unified Instagram intent', request.id));
      try {
        const principal = await authorize(request, 'schedules:read');
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const result = await service.get({
          workspaceId: principal.workspaceId,
          accountId: path.data.accountId,
          id: path.data.intentId,
        });
        return result
          ? await reply.send(successEnvelope(present(result), request.id))
          : await reply.code(404).send(errorEnvelope('not_found', 'Intent not found', request.id));
      } catch (error) {
        if (error instanceof MachineAuthorizationError)
          return await reply
            .code(403)
            .send(
              errorEnvelope(error.code, 'Unified Instagram schedule access denied', request.id),
            );
        throw error;
      }
    },
  );

  application.delete(
    '/api/v1/destinations/:accountId/instagram-unified-schedules/:intentId',
    async (request, reply) => {
      const path = intentParams.safeParse(request.params);
      if (!path.success)
        return reply
          .code(400)
          .send(errorEnvelope('invalid_request', 'Invalid Unified Instagram intent', request.id));
      try {
        const principal = await authorize(request, 'schedules:write');
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const limit = rateLimiter.check(principal.workspaceId, principal.actorId, 'mutation');
        if (!limit.allowed)
          return await reply
            .code(429)
            .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        const cancelled = await service.cancel({
          workspaceId: principal.workspaceId,
          accountId: path.data.accountId,
          id: path.data.intentId,
        });
        return cancelled
          ? await reply.send(
              successEnvelope({ id: path.data.intentId, status: 'cancelled' }, request.id),
            )
          : await reply
              .code(409)
              .send(errorEnvelope('not_pending', 'Intent is not pending', request.id));
      } catch (error) {
        if (error instanceof MachineAuthorizationError)
          return await reply
            .code(403)
            .send(
              errorEnvelope(error.code, 'Unified Instagram schedule access denied', request.id),
            );
        throw error;
      }
    },
  );
}

function present(result: {
  id: string;
  clientActionId: string;
  kind: string;
  targetId: string;
  parentId: string;
  recipientId: string | null;
  text: string;
  dueAt: Date;
  status: string;
}) {
  return {
    id: result.id,
    clientActionId: result.clientActionId,
    kind: result.kind,
    targetId: result.targetId,
    parentId: result.parentId,
    recipientId: result.recipientId,
    text: result.text,
    dueAt: result.dueAt.toISOString(),
    status: result.status,
  };
}
