import type { FastifyInstance, FastifyReply } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import type { CursorCodec } from '../api/contract.js';
import { InvalidCursorError, errorEnvelope, successEnvelope } from '../api/contract.js';
import { executeIdempotentMutation } from '../api/idempotency.repository.js';
import {
  InvalidIdempotencyKeyError,
  mutationFingerprint,
  validateIdempotencyKey,
} from '../api/idempotency.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import {
  ActionPolicyDeniedError,
  allowAllActionPolicy,
  type ActionPolicy,
} from '../policy/action-policy.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import {
  createPostRequestSchema,
  normalizeCreatePostRequest,
  postValidationRequestSchema,
} from './post.contract.js';
import { PostValidationError } from './post.errors.js';
import {
  browserJobStates,
  getJobDetail,
  getPostDetail,
  listBrowserJobSummaries,
  listPostSummaries,
} from './post-read.repository.js';
import { createPostInTransaction, validatePostCandidate } from './post.service.js';
import { requestOperatorRetryInTransaction } from '../scheduler/job.repository.js';

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
  principal: { workspaceId: string; actorId: string },
  requestId: string,
  reply: FastifyReply,
): Promise<boolean> {
  const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'read');
  void reply.header('X-RateLimit-Limit', decision.limit);
  void reply.header('X-RateLimit-Remaining', decision.remaining);
  if (decision.allowed) return true;
  void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
  await reply
    .code(429)
    .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', requestId));
  return false;
}

const jobListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  states: z.string().optional(),
  providerAccountId: z.uuid().optional(),
  scheduledAfter: z.iso.datetime().optional(),
  scheduledBefore: z.iso.datetime().optional(),
});

function parseJobListQuery(raw: unknown, cursorCodec: CursorCodec) {
  const parsed = jobListQuerySchema.parse(raw);
  const query = {
    ...parsed,
    scheduledAfter: parsed.scheduledAfter
      ? new Date(parsed.scheduledAfter).toISOString()
      : undefined,
    scheduledBefore: parsed.scheduledBefore
      ? new Date(parsed.scheduledBefore).toISOString()
      : undefined,
  };
  const states = query.states
    ? [
        ...new Set(
          query.states
            .split(',')
            .filter(Boolean)
            .map((state) => z.enum(browserJobStates).parse(state)),
        ),
      ].sort()
    : [];
  if (query.states && states.length === 0) throw new Error('Invalid states filter');
  if (
    query.scheduledAfter &&
    query.scheduledBefore &&
    Date.parse(query.scheduledAfter) > Date.parse(query.scheduledBefore)
  )
    throw new Error('Invalid schedule window');
  const filters = {
    resource: 'jobs',
    limit: query.limit,
    states: states.join(','),
    providerAccountId: query.providerAccountId ?? null,
    scheduledAfter: query.scheduledAfter ?? null,
    scheduledBefore: query.scheduledBefore ?? null,
  };
  const position = query.cursor ? cursorCodec.decode(query.cursor, filters).position : undefined;
  const before = position
    ? z.object({ scheduledAt: z.iso.datetime(), id: z.uuid() }).parse(JSON.parse(position))
    : undefined;
  return { query, states, filters, before };
}

export function registerPostRoutes(
  application: FastifyInstance,
  database: NodePgDatabase,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  cursorCodec: CursorCodec,
  actionPolicy: ActionPolicy = allowAllActionPolicy,
  delegatedAuthorization?: DelegatedAuthorizationService,
): void {
  application.get('/api/v1/posts', async (request, reply) => {
    try {
      const principal = await authorizeMachineRequest(
        request,
        apiKeys,
        delegatedAuthorization,
        'schedules:read',
      );
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
      if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
        return await reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
      if (error instanceof ActionPolicyDeniedError)
        return await reply
          .code(403)
          .send(errorEnvelope(error.code, error.message, request.id, error.metadata));
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
      const principal = await authorizeMachineRequest(
        request,
        apiKeys,
        delegatedAuthorization,
        'schedules:read',
      );
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
      if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
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

  application.get('/api/v1/jobs', async (request, reply) => {
    try {
      const principal = await authorizeMachineRequest(
        request,
        apiKeys,
        delegatedAuthorization,
        'schedules:read',
      );
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      if (!(await admitRead(rateLimiter, principal, request.id, reply))) return;
      const { query, states, filters, before } = parseJobListQuery(request.query, cursorCodec);
      const rows = await listBrowserJobSummaries(database, {
        workspaceId: principal.workspaceId,
        machineActor: { type: principal.kind, id: principal.actorId, capability: 'schedules:read' },
        limit: query.limit + 1,
        ...(states.length ? { states } : {}),
        ...(query.providerAccountId ? { providerAccountId: query.providerAccountId } : {}),
        ...(query.scheduledAfter ? { scheduledAfter: new Date(query.scheduledAfter) } : {}),
        ...(query.scheduledBefore ? { scheduledBefore: new Date(query.scheduledBefore) } : {}),
        ...(before ? { before: { scheduledAt: new Date(before.scheduledAt), id: before.id } } : {}),
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > query.limit && last
          ? cursorCodec.encode(
              JSON.stringify({ scheduledAt: last.scheduledAt.toISOString(), id: last.id }),
              filters,
            )
          : null;
      return await reply.send(
        successEnvelope(
          {
            items: page.map((job) => ({
              id: job.id,
              postId: job.postId,
              state: job.state,
              scheduledAt: job.scheduledAt,
              updatedAt: job.updatedAt,
              destination: {
                id: job.providerAccount.id,
                displayName: job.providerAccount.displayName,
                provider: job.providerAccount.provider,
              },
              links: { self: `/api/v1/jobs/${job.id}`, post: `/api/v1/posts/${job.postId}` },
            })),
            nextCursor,
          },
          request.id,
        ),
      );
    } catch (error) {
      if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
        return await reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
      if (
        error instanceof InvalidCursorError ||
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        (error instanceof Error && error.message.startsWith('Invalid '))
      )
        return await reply
          .code(400)
          .send(errorEnvelope('invalid_request', error.message, request.id));
      throw error;
    }
  });

  application.get('/api/v1/jobs/:jobId', async (request, reply) => {
    try {
      const principal = await authorizeMachineRequest(
        request,
        apiKeys,
        delegatedAuthorization,
        'schedules:read',
      );
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      if (!(await admitRead(rateLimiter, principal, request.id, reply))) return;
      const { jobId } = z.object({ jobId: z.uuid() }).parse(request.params);
      const job = await getJobDetail(database, principal.workspaceId, jobId, {
        type: principal.kind,
        id: principal.actorId,
        capability: 'schedules:read',
      });
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
      if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
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

  application.post('/api/v1/jobs/:jobId/retry', async (request, reply) => {
    try {
      const principal = await authorizeMachineRequest(
        request,
        apiKeys,
        delegatedAuthorization,
        'publishes:retry',
      );
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'mutation');
      if (!decision.allowed)
        return await reply
          .code(429)
          .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
      const { jobId } = z.object({ jobId: z.uuid() }).parse(request.params);
      const suppliedKey = request.headers['idempotency-key'];
      const idempotencyKey = validateIdempotencyKey(
        typeof suppliedKey === 'string' ? suppliedKey : undefined,
      );
      const result = await executeIdempotentMutation(
        database,
        {
          workspaceId: principal.workspaceId,
          actor: { type: principal.kind, id: principal.actorId },
          operation: 'publishes.retry',
          idempotencyKey,
          requestFingerprint: mutationFingerprint({ jobId }),
        },
        async (transaction) => {
          const outcome = await requestOperatorRetryInTransaction(
            transaction,
            {
              workspaceId: principal.workspaceId,
              jobId,
              actor: { type: principal.kind, id: principal.actorId },
              now: new Date(),
            },
            actionPolicy,
          );
          return outcome === 'scheduled'
            ? {
                statusCode: 202,
                body: successEnvelope(
                  { id: jobId, state: 'retry_wait', links: { self: `/api/v1/jobs/${jobId}` } },
                  request.id,
                ),
              }
            : {
                statusCode: 409,
                body: errorEnvelope(
                  'retry_conflict',
                  'Publication job is not eligible for retry',
                  request.id,
                ),
              };
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
      if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
        return await reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
      if (error instanceof z.ZodError || error instanceof InvalidIdempotencyKeyError)
        return await reply
          .code(400)
          .send(errorEnvelope('invalid_request', error.message, request.id));
      throw error;
    }
  });

  application.post('/api/v1/posts/validate', async (request, reply) => {
    try {
      const principal = await authorizeMachineRequest(
        request,
        apiKeys,
        delegatedAuthorization,
        'schedules:read',
      );
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      if (!(await admitRead(rateLimiter, principal, request.id, reply))) return;
      const body = postValidationRequestSchema.parse(request.body);
      const result = await validatePostCandidate(database, {
        workspaceId: principal.workspaceId,
        machineActor: { type: principal.kind, id: principal.actorId, capability: 'schedules:read' },
        ...normalizeCreatePostRequest(body),
        scheduledAt: new Date(body.scheduledAt),
        ...(body.validationPreview ? { xMediaPresent: true } : {}),
      });
      return await reply.send(successEnvelope(result, request.id));
    } catch (error) {
      if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
        return await reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
      if (error instanceof z.ZodError || error instanceof PostValidationError)
        return await reply
          .code(400)
          .send(errorEnvelope('invalid_request', error.message, request.id));
      request.log.error({ err: error }, 'Post validation failed');
      return await reply
        .code(500)
        .send(errorEnvelope('internal_error', 'Internal server error', request.id));
    }
  });

  application.post('/api/v1/posts', async (request, reply) => {
    try {
      const principal = await authorizeMachineRequest(
        request,
        apiKeys,
        delegatedAuthorization,
        'schedules:write',
      );
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'mutation');
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
          actor: { type: principal.kind, id: principal.actorId },
          operation: 'posts.create',
          machineCapability: 'schedules:write',
          idempotencyKey,
          requestFingerprint: mutationFingerprint(body),
        },
        async (transaction) => {
          const created = await createPostInTransaction(
            transaction,
            {
              workspaceId: principal.workspaceId,
              userId: principal.kind === 'api-key' ? principal.createdByUserId : principal.userId,
              actor: { type: principal.kind, id: principal.actorId },
              requestId: request.id,
              idempotencyKey,
              ...normalizeCreatePostRequest(body),
              scheduledAt: new Date(body.scheduledAt),
            },
            actionPolicy,
          );
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
      if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
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
