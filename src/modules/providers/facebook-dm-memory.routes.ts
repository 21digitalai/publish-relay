import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import {
  authorizePageEngagementRequest,
  MachineAuthorizationError,
} from '../identity/machine-auth.js';
import { getPageDmMemoryMany, upsertPageDmMemory } from './facebook-dm-memory.repository.js';

const conversationId = z
  .string()
  .regex(/^[A-Za-z0-9_]+$/)
  .max(256);
const accountParams = z.strictObject({ accountId: z.uuid() });
const memoryParams = accountParams.extend({ conversationId });
const getManyBody = z.strictObject({
  conversationIds: z
    .array(conversationId)
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length),
  terminal: z.enum(['include', 'exclude', 'only']).optional(),
});
const patchBody = z
  .strictObject({
    facts: z.array(z.string().trim().min(1).max(160)).max(10).optional(),
    firstContactAt: z.iso.datetime({ offset: true }).nullable().optional(),
    lastProcessedInboundId: z.string().trim().min(1).max(256).nullable().optional(),
    lastOutboundReceiptRef: z.string().trim().min(1).max(256).nullable().optional(),
    terminal: z.boolean().optional(),
    unansweredFollowUp: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0);

export function registerFacebookDmMemoryRoutes(
  application: FastifyInstance,
  database: NodePgDatabase,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
): void {
  application.post(
    '/api/v1/destinations/:accountId/facebook-conversations/memory/get-many',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      const params = accountParams.safeParse(request.params);
      const body = getManyBody.safeParse(request.body);
      if (!params.success || !body.success)
        return reply
          .code(400)
          .send(errorEnvelope('invalid_request', 'Invalid Page memory request', request.id));
      try {
        const principal = await authorizePageEngagementRequest(
          request,
          apiKeys,
          delegatedAuthorization,
          database,
          params.data.accountId,
          'dms:read',
        );
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const limit = rateLimiter.check(principal.workspaceId, principal.actorId, 'read');
        if (!limit.allowed) {
          void reply.header('Retry-After', limit.retryAfterSeconds ?? 1);
          return await reply
            .code(429)
            .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        }
        const records = await getPageDmMemoryMany(database, {
          workspaceId: principal.workspaceId,
          accountId: params.data.accountId,
          conversationIds: body.data.conversationIds,
          terminal: body.data.terminal,
        });
        return await reply.send(successEnvelope({ records }, request.id));
      } catch (error) {
        if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
          return await reply
            .code(403)
            .send(errorEnvelope(error.code, 'Page memory access denied', request.id));
        throw error;
      }
    },
  );

  application.patch(
    '/api/v1/destinations/:accountId/facebook-conversations/:conversationId/memory',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      const params = memoryParams.safeParse(request.params);
      const body = patchBody.safeParse(request.body);
      if (!params.success || !body.success)
        return reply
          .code(400)
          .send(errorEnvelope('invalid_request', 'Invalid Page memory update', request.id));
      try {
        const principal = await authorizePageEngagementRequest(
          request,
          apiKeys,
          delegatedAuthorization,
          database,
          params.data.accountId,
          'dms:propose',
        );
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const limit = rateLimiter.check(principal.workspaceId, principal.actorId, 'mutation');
        if (!limit.allowed) {
          void reply.header('Retry-After', limit.retryAfterSeconds ?? 1);
          return await reply
            .code(429)
            .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        }
        const { firstContactAt, ...rest } = body.data;
        const result = await upsertPageDmMemory(database, {
          workspaceId: principal.workspaceId,
          accountId: params.data.accountId,
          conversationId: params.data.conversationId,
          patch: {
            ...rest,
            ...(firstContactAt === undefined
              ? {}
              : { firstContactAt: firstContactAt === null ? null : new Date(firstContactAt) }),
          },
        });
        return await reply.send(successEnvelope(result, request.id));
      } catch (error) {
        if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
          return await reply
            .code(403)
            .send(errorEnvelope(error.code, 'Page memory access denied', request.id));
        throw error;
      }
    },
  );
}
