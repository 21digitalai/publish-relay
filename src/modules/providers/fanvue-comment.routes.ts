import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import { ActionPolicyDeniedError } from '../policy/action-policy.js';
import { FanvueActionConflictError, type FanvueCommentService } from './fanvue-comment.service.js';
import { FanvueRequestError } from './fanvue-http-client.js';
import { FanvueReadUnavailableError } from './fanvue-read.service.js';
import {
  cancelPendingFanvueComment,
  FanvueCommentScheduleConflictError,
  findScheduledFanvueComment,
} from './fanvue-comment-pending.repository.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

const params = z.strictObject({ accountId: z.uuid(), postUuid: z.uuid() });
export const fanvueCommentRequestSchema = z.strictObject({
  text: z.string().min(1).max(600),
  clientActionId: z.uuid(),
});
const scheduledRequest = fanvueCommentRequestSchema.extend({
  dueAt: z.iso.datetime({ offset: true }),
});
const scheduledParams = params.extend({ clientActionId: z.uuid() });

export function registerFanvueCommentRoutes(
  application: FastifyInstance,
  service: FanvueCommentService,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
  database?: NodePgDatabase,
): void {
  application.post(
    '/api/v1/fanvue/accounts/:accountId/posts/:postUuid/comments',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      try {
        const principal = await authorizeMachineRequest(
          request,
          apiKeys,
          delegatedAuthorization,
          'fanvue:comments:send',
        );
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const path = params.parse(request.params);
        const payload = fanvueCommentRequestSchema.parse(request.body);
        const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'mutation');
        if (!decision.allowed) {
          void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
          return await reply
            .code(429)
            .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        }
        const result = await service.send({
          workspaceId: principal.workspaceId,
          accountId: path.accountId,
          postUuid: path.postUuid,
          clientActionId: payload.clientActionId,
          text: payload.text,
          actor: { type: principal.kind, id: principal.actorId },
        });
        const status = result.state === 'confirmed' ? 201 : result.state === 'unknown' ? 202 : 409;
        return await reply.code(status).send(successEnvelope(result, request.id));
      } catch (error) {
        return sendCommentError(error, request, reply);
      }
    },
  );
  application.post(
    '/api/v1/fanvue/accounts/:accountId/posts/:postUuid/comments/scheduled',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      try {
        const principal = await authorizeMachineRequest(
          request,
          apiKeys,
          delegatedAuthorization,
          'fanvue:comments:send',
        );
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const path = params.parse(request.params);
        const payload = scheduledRequest.parse(request.body);
        const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'mutation');
        if (!decision.allowed) {
          void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
          return await reply
            .code(429)
            .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        }
        const result = await service.schedule({
          workspaceId: principal.workspaceId,
          accountId: path.accountId,
          postUuid: path.postUuid,
          clientActionId: payload.clientActionId,
          text: payload.text,
          dueAt: new Date(payload.dueAt),
          actor: { type: principal.kind, id: principal.actorId },
        });
        return await reply.code(202).send(successEnvelope(result, request.id));
      } catch (error) {
        return sendCommentError(error, request, reply);
      }
    },
  );
  application.get(
    '/api/v1/fanvue/accounts/:accountId/posts/:postUuid/comments/scheduled/:clientActionId',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      try {
        const principal = await authorizeMachineRequest(
          request,
          apiKeys,
          delegatedAuthorization,
          'fanvue:comments:send',
        );
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const path = scheduledParams.parse(request.params);
        if (!database) throw new Error('Comment schedule database unavailable');
        const row = await findScheduledFanvueComment(database, {
          workspaceId: principal.workspaceId,
          ...path,
        });
        if (!row)
          return await reply
            .code(404)
            .send(errorEnvelope('not_found', 'Scheduled comment not found', request.id));
        return await reply.send(
          successEnvelope(
            {
              clientActionId: row.clientActionId,
              status: row.status,
              dueAt: row.dueAt.toISOString(),
            },
            request.id,
          ),
        );
      } catch (error) {
        return sendCommentError(error, request, reply);
      }
    },
  );
  application.delete(
    '/api/v1/fanvue/accounts/:accountId/posts/:postUuid/comments/scheduled/:clientActionId',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      try {
        const principal = await authorizeMachineRequest(
          request,
          apiKeys,
          delegatedAuthorization,
          'fanvue:comments:send',
        );
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const path = scheduledParams.parse(request.params);
        if (!database) throw new Error('Comment schedule database unavailable');
        const cancelled = await cancelPendingFanvueComment(database, {
          workspaceId: principal.workspaceId,
          ...path,
        });
        if (!cancelled)
          return await reply
            .code(409)
            .send(errorEnvelope('not_pending', 'Comment is no longer pending', request.id));
        return await reply.send(
          successEnvelope({ clientActionId: path.clientActionId, status: 'cancelled' }, request.id),
        );
      } catch (error) {
        return sendCommentError(error, request, reply);
      }
    },
  );
}

function sendCommentError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
    return reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
  if (error instanceof z.ZodError)
    return reply
      .code(400)
      .send(errorEnvelope('invalid_request', 'Invalid comment request', request.id));
  if (error instanceof FanvueActionConflictError)
    return reply.code(409).send(errorEnvelope('action_conflict', error.message, request.id));
  if (error instanceof FanvueReadUnavailableError)
    return reply
      .code(error.reason === 'account_not_found' ? 404 : 409)
      .send(errorEnvelope(error.reason, error.message, request.id));
  if (error instanceof ActionPolicyDeniedError)
    return reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
  if (error instanceof FanvueRequestError)
    return reply
      .code(502)
      .send(
        errorEnvelope('provider_preflight_failed', 'Fanvue account preflight failed', request.id),
      );
  if (error instanceof FanvueCommentScheduleConflictError)
    return reply.code(409).send(errorEnvelope('action_conflict', error.message, request.id));
  request.log.error({ err: error }, 'Fanvue comment command failed');
  return reply.code(500).send(errorEnvelope('internal_error', 'Internal server error', request.id));
}
