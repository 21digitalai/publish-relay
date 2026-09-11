import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Readable } from 'node:stream';
import { z } from 'zod';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { mutationFingerprint, validateIdempotencyKey } from '../api/idempotency.js';
import { authorizeRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import {
  ActionPolicyDeniedError,
  allowAllActionPolicy,
  type ActionPolicy,
} from '../policy/action-policy.js';
import { WorkspaceAuthorizationError } from '../identity/authorization.js';
import { verifyCsrfToken } from '../identity/session.js';
import { cancelPendingJob, requestOperatorRetry } from '../scheduler/job.repository.js';
import { executeBrowserMutation } from './browser-idempotency.repository.js';
import {
  getExternalDraftForWorkspace,
  transitionExternalDraft,
} from './external-draft.repository.js';
import { getReadyMediaForDownload } from './media.repository.js';
import { deleteUnattachedMedia } from './media-retention.service.js';
import type { MediaStorage } from './media-storage.js';
import { FfprobeMediaProbe, type MediaProbe } from './media-probe.js';
import { detectMimeType, storeStagedMediaInTransaction } from './media.service.js';
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
const mediaParamsSchema = z.object({ mediaId: z.uuid() });
const draftParamsSchema = z.object({ draftId: z.uuid() });
const browserCreatePostSchema = createPostRequestSchema.extend({
  externalDraftId: z.uuid().optional(),
});
const reschedulePostSchema = z.object({ scheduledAt: z.iso.datetime() });
const NOW_SCHEDULE_CLOCK_SKEW_MS = 60_000;
const MAX_SCHEDULE_GUIDANCE_WINDOW_MS = 7 * 24 * 60 * 60_000;
const BROWSER_VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const BROWSER_VIDEO_LIMITS = { maxDurationMs: 60 * 60 * 1000, maxWidth: 8192, maxHeight: 8192 };

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
  if (error instanceof ActionPolicyDeniedError)
    return reply.code(403).send({
      data: null,
      error: error.message,
      code: error.code,
      metadata: error.metadata,
      requestId: request.id,
    });
  if (
    error instanceof z.ZodError ||
    error instanceof PostValidationError ||
    (error instanceof Error && /Media|Idempotency|Unsupported/.test(error.message))
  )
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
    media: job.media,
    attempts: job.attempts,
    activity: job.activity,
    providerResult: job.providerResult,
    creator: job.creator,
    lastMutator: job.lastMutator,
    providerAccount: job.providerAccount,
    links: { self: `/api/workflow/jobs/${job.id}`, post: `/api/v1/posts/${job.postId}` },
  };
}

function contentPreview(content: unknown): string {
  if (typeof content !== 'object' || content === null || !('text' in content)) return '';
  const text = content.text;
  return typeof text === 'string' ? text.slice(0, 160) : '';
}

function serializeJobSummary(job: Awaited<ReturnType<typeof listBrowserJobSummaries>>[number]) {
  return {
    id: job.id,
    postId: job.postId,
    state: job.state,
    scheduledAt: job.scheduledAt,
    updatedAt: job.updatedAt,
    contentPreview: contentPreview(job.content),
    media: {
      count: job.mediaCount,
      previewUrl: job.previewMediaId ? `/api/workflow/media/${job.previewMediaId}` : null,
    },
    creator: job.creator,
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
    mediaStorage?: MediaStorage;
    mediaProbe?: MediaProbe;
    videoConfig?: { maxBytes: number; limits: typeof BROWSER_VIDEO_LIMITS };
  },
): void {
  const actionPolicy = dependencies.actionPolicy ?? allowAllActionPolicy;
  const mediaStorage = dependencies.mediaStorage;
  const mediaProbe = dependencies.mediaProbe ?? new FfprobeMediaProbe();
  const videoConfig = dependencies.videoConfig ?? {
    maxBytes: BROWSER_VIDEO_MAX_BYTES,
    limits: BROWSER_VIDEO_LIMITS,
  };
  if (mediaStorage && !application.hasContentTypeParser('video/mp4'))
    application.addContentTypeParser(
      'video/mp4',
      { bodyLimit: videoConfig.maxBytes },
      (_request, body, done) => {
        done(null, body);
      },
    );
  if (mediaStorage)
    application.post('/api/workflow/media', async (request, reply) => {
      let temporaryKey: string | undefined;
      try {
        const identity = await authorizeRequest(request, dependencies.auth, 'content:write');
        if (!identity)
          return await reply.code(401).send({ data: null, error: 'Authentication required' });
        if (!authorizeMutation(request))
          return await reply.code(403).send({ data: null, error: 'CSRF validation failed' });
        const key = idempotencyKey(request.headers);
        if (!key)
          return await reply
            .code(400)
            .send({ data: null, error: 'A valid Idempotency-Key is required' });
        const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
        if (
          contentType !== 'video/mp4' ||
          !mediaStorage.stageStream ||
          !mediaStorage.promote ||
          !mediaProbe.probeMp4File
        )
          return await reply
            .code(400)
            .send({ data: null, error: 'A valid MP4 upload is required' });
        z.string().min(1).max(255).parse(request.headers['x-file-name']);
        const staged = await mediaStorage.stageStream({
          stream: request.body as Readable,
          maxBytes: videoConfig.maxBytes,
          fingerprintPrefix: Buffer.from('video/mp4\0'),
        });
        temporaryKey = staged.temporaryKey;
        if (detectMimeType(staged.prefix) !== 'video/mp4')
          throw new Error('Media Content-Type mismatch');
        const metadata = await mediaProbe.probeMp4File(staged.filePath);
        if (metadata.durationMs > videoConfig.limits.maxDurationMs)
          throw new Error('Media duration exceeds the configured limit');
        if (
          metadata.width > videoConfig.limits.maxWidth ||
          metadata.height > videoConfig.limits.maxHeight
        )
          throw new Error('Media dimensions exceed the configured limit');
        const result = await executeBrowserMutation(
          dependencies.database,
          {
            workspaceId: identity.workspaceId,
            userId: identity.userId,
            operation: 'media.create',
            idempotencyKey: key,
            requestFingerprint: staged.requestFingerprint,
          },
          async (transaction) => {
            const media = await storeStagedMediaInTransaction(
              transaction,
              mediaStorage,
              {
                workspaceId: identity.workspaceId,
                userId: identity.userId,
                actor: { type: 'user', id: identity.userId },
                requestId: request.id,
                idempotencyKey: key,
                staged,
                mimeType: 'video/mp4',
                metadata,
              },
              actionPolicy,
            );
            temporaryKey = `${identity.workspaceId}/${media.mediaId}/${media.sha256}`;
            return {
              statusCode: 201,
              body: {
                data: {
                  id: media.mediaId,
                  mimeType: media.mimeType,
                  byteSize: media.byteSize,
                  ...metadata,
                  state: 'ready',
                },
                error: null,
              },
            };
          },
        );
        temporaryKey = undefined;
        if (result.kind === 'conflict') {
          await mediaStorage.delete(staged.temporaryKey);
          return await reply
            .code(409)
            .send({ data: null, error: 'Idempotency key was already used' });
        }
        if (result.kind === 'replayed') {
          await mediaStorage.delete(staged.temporaryKey);
          void reply.header('Idempotency-Replayed', 'true');
        }
        return await reply.code(result.response.statusCode).send(result.response.body);
      } catch (error) {
        if (temporaryKey) await mediaStorage.delete(temporaryKey).catch(() => undefined);
        return mutationError(request, reply, error);
      }
    });
  if (mediaStorage)
    application.get('/api/workflow/media/:mediaId', async (request, reply) => {
      let identity;
      try {
        identity = await authorizeRequest(request, dependencies.auth, 'content:read');
      } catch (error) {
        return mutationError(request, reply, error);
      }
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      const params = mediaParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ data: null, error: 'Invalid media id' });
      const media = await getReadyMediaForDownload(
        dependencies.database,
        identity.workspaceId,
        params.data.mediaId,
      );
      if (!media) return reply.code(404).send({ data: null, error: 'Media was not found' });
      let bytes: Buffer;
      try {
        bytes = await mediaStorage.read(media.storageKey);
      } catch (error) {
        request.log.error({ err: error, mediaId: params.data.mediaId }, 'Media read failed');
        return reply.code(500).send({ data: null, error: 'Stored media is unavailable' });
      }
      if (bytes.byteLength !== media.byteSize)
        return reply.code(500).send({ data: null, error: 'Stored media is unavailable' });
      return reply.header('cache-control', 'private, max-age=300').type(media.mimeType).send(bytes);
    });
  if (mediaStorage)
    application.delete('/api/workflow/media/:mediaId', async (request, reply) => {
      try {
        const identity = await authorizeRequest(request, dependencies.auth, 'content:write');
        if (!identity)
          return await reply.code(401).send({ data: null, error: 'Authentication required' });
        if (!authorizeMutation(request))
          return await reply.code(403).send({ data: null, error: 'CSRF validation failed' });
        const params = mediaParamsSchema.safeParse(request.params);
        if (!params.success)
          return await reply.code(400).send({ data: null, error: 'Invalid media id' });
        const deleted = await deleteUnattachedMedia(dependencies.database, mediaStorage, {
          workspaceId: identity.workspaceId,
          mediaId: params.data.mediaId,
        });
        return await reply.send({ data: { deleted }, error: null });
      } catch (error) {
        return mutationError(request, reply, error);
      }
    });
  application.get('/api/workflow/drafts/:draftId', async (request, reply) => {
    const identity = await authorizeRequest(request, dependencies.auth, 'content:write');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const params = draftParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ data: null, error: 'Invalid draft id' });
    const draft = await withTenantTransaction(
      dependencies.database,
      { workspaceId: identity.workspaceId, userId: identity.userId },
      (transaction) =>
        getExternalDraftForWorkspace(transaction, {
          workspaceId: identity.workspaceId,
          draftId: params.data.draftId,
        }),
    );
    if (!draft) return reply.code(404).send({ data: null, error: 'Draft was not found' });
    return reply.send({
      data: { id: draft.id, label: draft.label, mediaIds: draft.mediaIds, postId: draft.postId },
      error: null,
    });
  });
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
    const parsed = browserCreatePostSchema.safeParse(request.body);
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
          const created = await createPostInTransaction(
            transaction,
            {
              workspaceId: identity.workspaceId,
              userId: identity.userId,
              requestId: request.id,
              idempotencyKey: key,
              content: body.content,
              mediaIds: body.mediaIds,
              providerAccountIds: body.providerAccountIds,
              scheduledAt: new Date(body.scheduledAt),
            },
            actionPolicy,
          );
          if (body.externalDraftId) {
            const transitioned = await transitionExternalDraft(transaction, {
              workspaceId: identity.workspaceId,
              draftId: body.externalDraftId,
              postId: created.postId,
              userId: identity.userId,
              requestId: request.id,
            });
            if (!transitioned)
              throw new PostValidationError('Draft is unavailable or already used');
          }
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
    const responseBody = result.response.body as {
      data: { jobIds?: string[] };
      error: null;
    };
    const jobs = await Promise.all(
      (responseBody.data.jobIds ?? []).map(async (jobId) => {
        const job = await getBrowserJobDetail(dependencies.database, identity.workspaceId, jobId);
        return job
          ? { id: job.id, effectiveProviderSettings: job.effectiveProviderSettings }
          : { id: jobId, effectiveProviderSettings: null };
      }),
    );
    return reply.code(result.response.statusCode).send({
      ...responseBody,
      data: { ...responseBody.data, jobs },
    });
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
          const edited = await editPostInTransaction(
            transaction,
            {
              workspaceId: identity.workspaceId,
              userId: identity.userId,
              requestId: request.id,
              idempotencyKey: key,
              postId: params.data.postId,
              content: body.content,
              mediaIds: body.mediaIds,
              providerAccountIds: body.providerAccountIds,
              scheduledAt: new Date(body.scheduledAt),
            },
            actionPolicy,
          );
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
            data: await reschedulePostInTransaction(
              transaction,
              {
                workspaceId: identity.workspaceId,
                userId: identity.userId,
                requestId: request.id,
                idempotencyKey: key,
                postId: params.data.postId,
                scheduledAt: new Date(parsed.data.scheduledAt),
              },
              actionPolicy,
            ),
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
        result = await requestOperatorRetry(
          dependencies.database,
          {
            workspaceId: identity.workspaceId,
            jobId: params.data.jobId,
            actorId: identity.userId,
            now: new Date(),
          },
          actionPolicy,
        );
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
