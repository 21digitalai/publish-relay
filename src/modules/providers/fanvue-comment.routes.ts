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

const params = z.strictObject({ accountId: z.uuid(), postUuid: z.uuid() });
const body = z.strictObject({ text: z.string().min(1).max(600), clientActionId: z.uuid() });

export function registerFanvueCommentRoutes(
  application: FastifyInstance,
  service: FanvueCommentService,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
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
        const payload = body.parse(request.body);
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
  request.log.error({ err: error }, 'Fanvue comment command failed');
  return reply.code(500).send(errorEnvelope('internal_error', 'Internal server error', request.id));
}
