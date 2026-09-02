import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { mutationFingerprint, validateIdempotencyKey } from '../api/idempotency.js';
import { authorizeRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { allowAllActionPolicy, type ActionPolicy } from '../policy/action-policy.js';
import { WorkspaceAuthorizationError } from '../identity/authorization.js';
import { verifyCsrfToken } from '../identity/session.js';
import { cancelPendingJob, requestOperatorRetry } from '../scheduler/job.repository.js';
import { executeBrowserMutation } from './browser-idempotency.repository.js';
import { createPostRequestSchema } from './post.contract.js';
import { PostNotFoundError, PostValidationError } from './post.errors.js';
import {
  createPostInTransaction,
  editPostInTransaction,
  reschedulePostInTransaction,
} from './post.service.js';
import {
  browserJobStates,
  getBrowserJobDetail,
  listBrowserJobSummaries,
} from './post-read.repository.js';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  states: z
    .string()
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(z.enum(browserJobStates)).max(browserJobStates.length))
    .optional(),
  providerAccountId: z.uuid().optional(),
  scheduledAfter: z.iso.datetime().optional(),
  scheduledBefore: z.iso.datetime().optional(),
  beforeScheduledAt: z.iso.datetime().optional(),
  beforeId: z.uuid().optional(),
});
const jobParamsSchema = z.object({ jobId: z.uuid() });
const postParamsSchema = z.object({ postId: z.uuid() });
const reschedulePostSchema = z.object({ scheduledAt: z.iso.datetime() });
const NOW_SCHEDULE_CLOCK_SKEW_MS = 60_000;
const MAX_SCHEDULE_GUIDANCE_WINDOW_MS = 7 * 24 * 60 * 60_000;

function authorizeMutation(request: FastifyRequest): boolean {
  const cookies = request.cookies as Record<string, string | undefined> | undefined;
  const cookieHeader = request.headers.cookie ?? '';
  const csrfCookie = cookieHeader
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${CSRF_COOKIE}=`))
    ?.slice(CSRF_COOKIE.length + 1);
  return verifyCsrfToken(
    cookies?.[CSRF_COOKIE] ?? csrfCookie,
    request.headers['x-csrf-token'] as string | undefined,
  );
}

function idempotencyKey(headers: Record<string, unknown>): string | null {
  try {
    const value = headers['idempotency-key'];
    return validateIdempotencyKey(typeof value === 'string' ? value : undefined);
  } catch {
    return null;
  }
}

function isPastSchedule(value: string, now = new Date()): boolean {
  return new Date(value).getTime() < now.getTime() - NOW_SCHEDULE_CLOCK_SKEW_MS;
}

function mutationError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof WorkspaceAuthorizationError)
    return reply
      .code(403)
      .send({ data: null, error: 'You cannot change content in this workspace' });
  if (error instanceof z.ZodError || error instanceof PostValidationError)
    return reply.code(400).send({ data: null, error: error.message });
  if (error instanceof PostNotFoundError)
    return reply.code(404).send({ data: null, error: 'Post was not found' });
  request.log.error({ err: error }, 'Browser mutation failed');
  return reply.code(500).send({ data: null, error: 'Internal server error' });
}

function serializeJob(job: Awaited<ReturnType<typeof getBrowserJobDetail>>) {
  if (!job) return null;
  return {
    id: job.id,
    postId: job.postId,
    state: job.state,
    scheduledAt: job.scheduledAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    content: job.content,
    providerAccount: job.providerAccount,
    links: { self: `/api/workflow/jobs/${job.id}`, post: `/api/v1/posts/${job.postId}` },
  };
}

function contentPreview(content: unknown): string {
  if (typeof content !== 'object' || content === null || !('text' in content)) return '';
  const text = content.text;
  return typeof text === 'string' ? text.slice(0, 160) : '';
}

function serializeJobSummary(job: NonNullable<Awaited<ReturnType<typeof getBrowserJobDetail>>>) {
  return {
    id: job.id,
    postId: job.postId,
    state: job.state,
    scheduledAt: job.scheduledAt,
    updatedAt: job.updatedAt,
    contentPreview: contentPreview(job.content),
    providerAccount: job.providerAccount,
    links: { self: `/api/workflow/jobs/${job.id}` },
  };
}

export function registerBrowserWorkflowRoutes(
  application: FastifyInstance,
  dependencies: {
    auth: AuthService;
    database: NodePgDatabase;
    now?: () => Date;
    actionPolicy?: ActionPolicy;
  },
): void {
  const actionPolicy = dependencies.actionPolicy ?? allowAllActionPolicy;
  application.post('/api/workflow/posts', async (request, reply) => {
    let identity;
    try {
      identity = await authorizeRequest(request, dependencies.auth, 'content:write');
    } catch (error) {
      return mutationError(request, reply, error);
    }
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!authorizeMutation(request))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const key = idempotencyKey(request.headers);
    if (!key)
      return reply.code(400).send({ data: null, error: 'A valid Idempotency-Key is required' });
    const parsed = createPostRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ data: null, error: 'Invalid post' });
    const body = parsed.data;
    if (isPastSchedule(body.scheduledAt, dependencies.now?.()))
      return reply.code(400).send({ data: null, error: 'Scheduled time must not be in the past' });
    let result;
    try {
      result = await executeBrowserMutation(
        dependencies.database,
        {
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          operation: 'create-post',
          idempotencyKey: key,
          requestFingerprint: mutationFingerprint(body),
        },
        async (transaction) => {
          const created = await createPostInTransaction(transaction, {
            workspaceId: identity.workspaceId,
            userId: identity.userId,
            content: body.content,
            mediaIds: body.mediaIds,
            providerAccountIds: body.providerAccountIds,
            scheduledAt: new Date(body.scheduledAt),
          }, actionPolicy);
          return {
            statusCode: 201,
            body: {
              data: {
                id: created.postId,
                revisionId: created.revisionId,
                jobIds: created.jobIds,
              },
              error: null,
            },
          };
        },
      );
    } catch (error) {
      return mutationError(request, reply, error);
    }
    if (result.kind === 'conflict')
      return reply.code(409).send({ data: null, error: 'Idempotency key was already used' });
    if (result.kind === 'replayed') reply.header('idempotency-replayed', 'true');
    return reply.code(result.response.statusCode).send(result.response.body);
  });

  application.patch('/api/workflow/posts/:postId', async (request, reply) => {
    let identity;
    try {
      identity = await authorizeRequest(request, dependencies.auth, 'content:write');
    } catch (error) {
      return mutationError(request, reply, error);
    }
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!authorizeMutation(request))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const key = idempotencyKey(request.headers);
    if (!key)
      return reply.code(400).send({ data: null, error: 'A valid Idempotency-Key is required' });
    const params = postParamsSchema.safeParse(request.params);
    const parsed = createPostRequestSchema.safeParse(request.body);
    if (!params.success || !parsed.success)
      return reply.code(400).send({ data: null, error: 'Invalid post revision' });
    const body = parsed.data;
    if (isPastSchedule(body.scheduledAt, dependencies.now?.()))
      return reply.code(400).send({ data: null, error: 'Scheduled time must not be in the past' });
    let result;
    try {
      result = await executeBrowserMutation(
        dependencies.database,
        {
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          operation: `edit-post:${params.data.postId}`,
          idempotencyKey: key,
          requestFingerprint: mutationFingerprint(body),
        },
        async (transaction) => {
          const edited = await editPostInTransaction(transaction, {
            workspaceId: identity.workspaceId,
            userId: identity.userId,
            postId: params.data.postId,
            content: body.content,
            mediaIds: body.mediaIds,
            providerAccountIds: body.providerAccountIds,
            scheduledAt: new Date(body.scheduledAt),
          }, actionPolicy);
          return { statusCode: 200, body: { data: edited, error: null } };
        },
      );
    } catch (error) {
      return mutationError(request, reply, error);
    }
    if (result.kind === 'conflict')
      return reply.code(409).send({ data: null, error: 'Idempotency key was already used' });
    if (result.kind === 'replayed') reply.header('idempotency-replayed', 'true');
    return reply.code(result.response.statusCode).send(result.response.body);
  });

  application.patch('/api/workflow/posts/:postId/schedule', async (request, reply) => {
    let identity;
    try {
      identity = await authorizeRequest(request, dependencies.auth, 'content:write');
    } catch (error) {
      return mutationError(request, reply, error);
    }
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!authorizeMutation(request))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const key = idempotencyKey(request.headers);
    const params = postParamsSchema.safeParse(request.params);
    const parsed = reschedulePostSchema.safeParse(request.body);
    if (!key || !params.success || !parsed.success)
      return reply.code(400).send({ data: null, error: 'Invalid schedule revision' });
    if (isPastSchedule(parsed.data.scheduledAt, dependencies.now?.()))
      return reply.code(400).send({ data: null, error: 'Scheduled time must not be in the past' });
    try {
      const result = await executeBrowserMutation(
        dependencies.database,
        {
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          operation: `reschedule-post:${params.data.postId}`,
          idempotencyKey: key,
          requestFingerprint: mutationFingerprint(parsed.data),
        },
        async (transaction) => ({
          statusCode: 200,
          body: {
            data: await reschedulePostInTransaction(transaction, {
              workspaceId: identity.workspaceId,
              userId: identity.userId,
              postId: params.data.postId,
              scheduledAt: new Date(parsed.data.scheduledAt),
            }, actionPolicy),
            error: null,
          },
        }),
      );
      if (result.kind === 'conflict')
        return await reply
          .code(409)
          .send({ data: null, error: 'Idempotency key was already used' });
      if (result.kind === 'replayed') reply.header('idempotency-replayed', 'true');
      return await reply.code(result.response.statusCode).send(result.response.body);
    } catch (error) {
      return mutationError(request, reply, error);
    }
  });

  application.get('/api/workflow/jobs', async (request, reply) => {
    const identity = await authorizeRequest(request, dependencies.auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ data: null, error: 'Invalid queue filters' });
    const query = parsed.data;
    if (Boolean(query.beforeScheduledAt) !== Boolean(query.beforeId))
      return reply.code(400).send({ data: null, error: 'Incomplete queue cursor' });
    if (
      Boolean(query.scheduledAfter) !== Boolean(query.scheduledBefore) ||
      (query.scheduledAfter &&
        query.scheduledBefore &&
        (new Date(query.scheduledBefore).getTime() <= new Date(query.scheduledAfter).getTime() ||
          new Date(query.scheduledBefore).getTime() - new Date(query.scheduledAfter).getTime() >
            MAX_SCHEDULE_GUIDANCE_WINDOW_MS))
    )
      return reply.code(400).send({ data: null, error: 'Invalid schedule window' });
    const rows = await listBrowserJobSummaries(dependencies.database, {
      workspaceId: identity.workspaceId,
      limit: query.limit + 1,
      ...(query.states ? { states: query.states } : {}),
      ...(query.providerAccountId ? { providerAccountId: query.providerAccountId } : {}),
      ...(query.scheduledAfter ? { scheduledAfter: new Date(query.scheduledAfter) } : {}),
      ...(query.scheduledBefore ? { scheduledBefore: new Date(query.scheduledBefore) } : {}),
      ...(query.beforeScheduledAt && query.beforeId
        ? { before: { scheduledAt: new Date(query.beforeScheduledAt), id: query.beforeId } }
        : {}),
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: {
        items: page.map((job) => serializeJobSummary(job)),
        next:
          rows.length > query.limit && last
            ? { beforeScheduledAt: last.scheduledAt.toISOString(), beforeId: last.id }
            : null,
      },
      error: null,
    };
  });

  application.get('/api/workflow/jobs/:jobId', async (request, reply) => {
    const identity = await authorizeRequest(request, dependencies.auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const params = jobParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ data: null, error: 'Invalid job' });
    const job = await getBrowserJobDetail(
      dependencies.database,
      identity.workspaceId,
      params.data.jobId,
    );
    return job
      ? { data: serializeJob(job), error: null }
      : reply.code(404).send({ data: null, error: 'Job was not found' });
  });

  application.post('/api/workflow/jobs/:jobId/cancel', async (request, reply) => {
    let identity;
    try {
      identity = await authorizeRequest(request, dependencies.auth, 'content:write');
    } catch (error) {
      return mutationError(request, reply, error);
    }
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!authorizeMutation(request))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    if (!idempotencyKey(request.headers))
      return reply.code(400).send({ data: null, error: 'A valid Idempotency-Key is required' });
    const params = jobParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ data: null, error: 'Invalid job' });
    let existing;
    let cancelled;
    try {
      existing = await getBrowserJobDetail(
        dependencies.database,
        identity.workspaceId,
        params.data.jobId,
      );
      if (existing && existing.state !== 'cancelled')
        cancelled = await cancelPendingJob(dependencies.database, {
          workspaceId: identity.workspaceId,
          jobId: params.data.jobId,
          actorId: identity.userId,
          now: new Date(),
        });
    } catch (error) {
      return mutationError(request, reply, error);
    }
    if (!existing) return reply.code(404).send({ data: null, error: 'Job was not found' });
    if (existing.state === 'cancelled') return { data: { state: 'cancelled' }, error: null };
    return cancelled
      ? { data: { state: 'cancelled' }, error: null }
      : reply.code(409).send({ data: null, error: 'This job can no longer be cancelled' });
  });

  application.post('/api/workflow/jobs/:jobId/retry', async (request, reply) => {
    let identity;
    try {
      identity = await authorizeRequest(request, dependencies.auth, 'content:write');
    } catch (error) {
      return mutationError(request, reply, error);
    }
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!authorizeMutation(request))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    if (!idempotencyKey(request.headers))
      return reply.code(400).send({ data: null, error: 'A valid Idempotency-Key is required' });
    const params = jobParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ data: null, error: 'Invalid job' });
    let existing;
    let result;
    try {
      existing = await getBrowserJobDetail(
        dependencies.database,
        identity.workspaceId,
        params.data.jobId,
      );
      if (existing && existing.state !== 'retry_wait')
        result = await requestOperatorRetry(dependencies.database, {
          workspaceId: identity.workspaceId,
          jobId: params.data.jobId,
          actorId: identity.userId,
          now: new Date(),
        }, actionPolicy);
    } catch (error) {
      return mutationError(request, reply, error);
    }
    if (!existing) return reply.code(404).send({ data: null, error: 'Job was not found' });
    if (existing.state === 'retry_wait') return { data: { state: 'retry_wait' }, error: null };
    return result === 'scheduled'
      ? { data: { state: 'retry_wait' }, error: null }
      : reply.code(409).send({ data: null, error: 'This job is not eligible for retry' });
  });
}
