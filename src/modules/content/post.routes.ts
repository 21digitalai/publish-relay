import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import { executeIdempotentMutation } from '../api/idempotency.repository.js';
import { mutationFingerprint, validateIdempotencyKey } from '../api/idempotency.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import { authorizeApiKeyRequest } from '../identity/api-key.routes.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import { createPostInTransaction } from './post.service.js';

const createPostSchema = z.object({
  content: z.record(z.string(), z.unknown()),
  mediaIds: z.array(z.uuid()).max(10).default([]),
  providerAccountIds: z.array(z.uuid()).min(1).max(50),
  scheduledAt: z.iso.datetime(),
});

function resourceLinks(result: { postId: string; revisionId: string; jobIds: string[] }) {
  return {
    id: result.postId,
    revisionId: result.revisionId,
    links: {
      self: `/api/v1/posts/${result.postId}`,
      jobs: result.jobIds.map((jobId) => `/api/v1/jobs/${jobId}`),
    },
  };
}

export function registerPostRoutes(
  application: FastifyInstance,
  database: NodePgDatabase,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
): void {
  application.post('/api/v1/posts', async (request, reply) => {
    try {
      const principal = await authorizeApiKeyRequest(request, apiKeys, 'schedules:write');
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      const decision = rateLimiter.check(principal.workspaceId, principal.id, 'mutation');
      void reply.header('X-RateLimit-Limit', decision.limit);
      void reply.header('X-RateLimit-Remaining', decision.remaining);
      if (!decision.allowed) {
        void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
        return await reply
          .code(429)
          .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
      }
      const body = createPostSchema.parse(request.body);
      const suppliedIdempotencyKey = request.headers['idempotency-key'];
      const idempotencyKey = validateIdempotencyKey(
        typeof suppliedIdempotencyKey === 'string' ? suppliedIdempotencyKey : undefined,
      );
      const result = await executeIdempotentMutation(
        database,
        {
          workspaceId: principal.workspaceId,
          apiKeyId: principal.id,
          operation: 'posts.create',
          idempotencyKey,
          requestFingerprint: mutationFingerprint(body),
        },
        async (transaction) => {
          const created = await createPostInTransaction(transaction, {
            workspaceId: principal.workspaceId,
            userId: principal.createdByUserId,
            content: body.content,
            mediaIds: body.mediaIds,
            providerAccountIds: body.providerAccountIds,
            scheduledAt: new Date(body.scheduledAt),
          });
          return { statusCode: 201, body: successEnvelope(resourceLinks(created), request.id) };
        },
      );
      if (result.kind === 'conflict')
        return await reply
          .code(409)
          .send(
            errorEnvelope('idempotency_conflict', 'Idempotency key was already used', request.id),
          );
      if (result.kind === 'replayed') void reply.header('Idempotency-Replayed', 'true');
      return await reply.code(result.response.statusCode).send(result.response.body);
    } catch (error) {
      if (error instanceof ApiKeyAuthorizationError)
        return await reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
      if (error instanceof z.ZodError || error instanceof Error)
        return await reply
          .code(400)
          .send(errorEnvelope('invalid_request', error.message, request.id));
      throw error;
    }
  });
}
