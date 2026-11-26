import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { successEnvelope, errorEnvelope } from '../api/contract.js';
import { executeIdempotentMutation } from '../api/idempotency.repository.js';
import {
  InvalidIdempotencyKeyError,
  mutationFingerprint,
  validateIdempotencyKey,
} from '../api/idempotency.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { ApiKeyService } from '../identity/api-key.service.js';
import { ApiKeyAuthorizationError } from '../identity/api-key.service.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { ActionPolicyDeniedError, type ActionPolicy } from '../policy/action-policy.js';
import {
  PostNotFoundError,
  PostRevisionConflictError,
  PostValidationError,
} from './post.errors.js';
import { replacePostMediaInTransaction } from './post-media.service.js';
import { replacePostMediaSchema } from './post.contract.js';

export function registerPostMediaRoutes(
  application: FastifyInstance,
  dependencies: {
    database: NodePgDatabase;
    apiKeys: ApiKeyService;
    rateLimiter: ApiRateLimiter;
    actionPolicy: ActionPolicy;
    delegatedAuthorization?: DelegatedAuthorizationService;
    enabledAdapters?: ReadonlySet<string>;
  },
) {
  application.patch('/api/v1/posts/:postId/media', async (request, reply) => {
    try {
      const principal = await authorizeMachineRequest(
        request,
        dependencies.apiKeys,
        dependencies.delegatedAuthorization,
        'content:write',
      );
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      const decision = dependencies.rateLimiter.check(
        principal.workspaceId,
        principal.actorId,
        'mutation',
      );
      if (!decision.allowed)
        return await reply
          .code(429)
          .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
      const { postId } = z.object({ postId: z.uuid() }).parse(request.params);
      const body = replacePostMediaSchema.parse(request.body);
      const key = request.headers['idempotency-key'];
      const idempotencyKey = validateIdempotencyKey(typeof key === 'string' ? key : undefined);
      const actor = { type: principal.kind, id: principal.actorId };
      const result = await executeIdempotentMutation(
        dependencies.database,
        {
          workspaceId: principal.workspaceId,
          actor,
          operation: 'post.media.replace',
          machineCapability: 'content:write',
          idempotencyKey,
          requestFingerprint: mutationFingerprint({ postId, ...body }),
        },
        async (transaction) => {
          const changed = await replacePostMediaInTransaction(
            transaction,
            {
              ...body,
              postId,
              workspaceId: principal.workspaceId,
              userId: principal.kind === 'api-key' ? principal.createdByUserId : principal.userId,
              actor,
              requestId: request.id,
              idempotencyKey,
              ...(dependencies.enabledAdapters
                ? { enabledAdapters: dependencies.enabledAdapters }
                : {}),
            },
            dependencies.actionPolicy,
          );
          return { statusCode: 200, body: successEnvelope(changed, request.id) };
        },
      );
      if (result.kind === 'conflict')
        return await reply
          .code(409)
          .send(errorEnvelope('idempotency_conflict', 'Idempotency key already used', request.id));
      if (result.kind === 'replayed') reply.header('Idempotency-Replayed', 'true');
      return await reply.code(result.response.statusCode).send(result.response.body);
    } catch (error) {
      if (error instanceof PostRevisionConflictError)
        return await reply
          .code(409)
          .send(errorEnvelope('post_revision_conflict', error.message, request.id));
      if (error instanceof PostNotFoundError)
        return await reply.code(404).send(errorEnvelope('not_found', 'Post not found', request.id));
      if (
        error instanceof ApiKeyAuthorizationError ||
        error instanceof MachineAuthorizationError ||
        error instanceof ActionPolicyDeniedError
      )
        return await reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
      if (
        error instanceof z.ZodError ||
        error instanceof PostValidationError ||
        error instanceof InvalidIdempotencyKeyError
      )
        return await reply
          .code(400)
          .send(errorEnvelope('invalid_request', error.message, request.id));
      request.log.error({ err: error }, 'Post media replacement failed');
      return await reply
        .code(500)
        .send(errorEnvelope('internal_error', 'Internal server error', request.id));
    }
  });
}
