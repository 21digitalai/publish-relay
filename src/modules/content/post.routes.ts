import type { FastifyInstance, FastifyReply } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import type { CursorCodec } from '../api/contract.js';
import { InvalidCursorError, errorEnvelope, successEnvelope } from '../api/contract.js';
import { executeIdempotentMutation } from '../api/idempotency.repository.js';
import { mutationFingerprint, validateIdempotencyKey } from '../api/idempotency.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import { authorizeApiKeyRequest } from '../identity/api-key.routes.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import { createPostRequestSchema } from './post.contract.js';
import { PostValidationError } from './post.errors.js';
import { getJobDetail, getPostDetail, listPostSummaries } from './post-read.repository.js';
import { createPostInTransaction } from './post.service.js';

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

async function admitRead(
  rateLimiter: ApiRateLimiter,
  principal: { workspaceId: string; id: string },
  requestId: string,
  reply: FastifyReply,
): Promise<boolean> {
  const decision = rateLimiter.check(principal.workspaceId, principal.id, 'read');
  void reply.header('X-RateLimit-Limit', decision.limit);
  void reply.header('X-RateLimit-Remaining', decision.remaining);
  if (decision.allowed) return true;
  void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
  await reply
    .code(429)
    .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', requestId));
  return false;
}

export function registerPostRoutes(
  application: FastifyInstance,
  database: NodePgDatabase,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  cursorCodec: CursorCodec,
): void {
  application.get('/api/v1/posts', async (request, reply) => {
    try {
      const principal = await authorizeApiKeyRequest(request, apiKeys, 'schedules:read');
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      if (!(await admitRead(rateLimiter, principal, request.id, reply))) return;
      const query = z
        .object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(request.query);
      const filters = { resource: 'posts', limit: query.limit };
      const position = query.cursor
        ? cursorCodec.decode(query.cursor, filters).position
        : undefined;
      const before = position
        ? z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).parse(JSON.parse(position))
        : undefined;
      const rows = await listPostSummaries(database, {
        workspaceId: principal.workspaceId,
        limit: query.limit + 1,
        ...(before ? { before: { createdAt: new Date(before.createdAt), id: before.id } } : {}),
      });
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > query.limit && last
          ? cursorCodec.encode(
              JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
              filters,
            )
          : null;
      return await reply.send(
        successEnvelope(
          {
            items: page.map((post) => ({ ...post, links: { self: `/api/v1/posts/${post.id}` } })),
            nextCursor,
          },
          request.id,
        ),
      );
    } catch (error) {
      if (error instanceof ApiKeyAuthorizationError)
        return await reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
      if (
        error instanceof InvalidCursorError ||
        error instanceof z.ZodError ||
        error instanceof SyntaxError
      )
        return await reply
          .code(400)
          .send(errorEnvelope('invalid_request', error.message, request.id));
      throw error;
    }
  });

  application.get('/api/v1/posts/:postId', async (request, reply) => {
    try {
      const principal = await authorizeApiKeyRequest(request, apiKeys, 'schedules:read');
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      if (!(await admitRead(rateLimiter, principal, request.id, reply))) return;
      const { postId } = z.object({ postId: z.uuid() }).parse(request.params);
      const post = await getPostDetail(database, principal.workspaceId, postId);
      if (!post)
        return await reply.code(404).send(errorEnvelope('not_found', 'Post not found', request.id));
      return await reply.send(
        successEnvelope(
          {
            ...post,
            links: { self: `/api/v1/posts/${post.id}` },
            jobs: post.jobs.map((job) => ({ ...job, links: { self: `/api/v1/jobs/${job.id}` } })),
          },
          request.id,
        ),
      );
    } catch (error) {
      if (error instanceof ApiKeyAuthorizationError)
        return await reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
      if (error instanceof z.ZodError)
        return await reply
          .code(400)
          .send(errorEnvelope('invalid_request', error.message, request.id));
      request.log.error({ err: error }, 'Post detail request failed');
      return await reply
        .code(500)
        .send(errorEnvelope('internal_error', 'Internal server error', request.id));
    }
  });

  application.get('/api/v1/jobs/:jobId', async (request, reply) => {
    try {
      const principal = await authorizeApiKeyRequest(request, apiKeys, 'schedules:read');
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      if (!(await admitRead(rateLimiter, principal, request.id, reply))) return;
      const { jobId } = z.object({ jobId: z.uuid() }).parse(request.params);
      const job = await getJobDetail(database, principal.workspaceId, jobId);
      if (!job)
        return await reply.code(404).send(errorEnvelope('not_found', 'Job not found', request.id));
      return await reply.send(
        successEnvelope(
          {
            ...job,
            links: { self: `/api/v1/jobs/${job.id}`, post: `/api/v1/posts/${job.postId}` },
          },
          request.id,
        ),
      );
    } catch (error) {
      if (error instanceof ApiKeyAuthorizationError)
        return await reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
      if (error instanceof z.ZodError)
        return await reply
          .code(400)
          .send(errorEnvelope('invalid_request', error.message, request.id));
      request.log.error({ err: error }, 'Job detail request failed');
      return await reply
        .code(500)
        .send(errorEnvelope('internal_error', 'Internal server error', request.id));
    }
  });

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
      const body = createPostRequestSchema.parse(request.body);
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
      if (error instanceof z.ZodError || error instanceof PostValidationError)
        return await reply
          .code(400)
          .send(errorEnvelope('invalid_request', error.message, request.id));
      request.log.error({ err: error }, 'Post mutation failed');
      return await reply
        .code(500)
        .send(errorEnvelope('internal_error', 'Internal server error', request.id));
    }
  });
}
