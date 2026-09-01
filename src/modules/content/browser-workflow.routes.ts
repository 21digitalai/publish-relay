import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { authorizeRequest } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
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
  beforeScheduledAt: z.iso.datetime().optional(),
  beforeId: z.uuid().optional(),
});

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
  dependencies: { auth: AuthService; database: NodePgDatabase },
): void {
  application.get('/api/workflow/jobs', async (request, reply) => {
    const identity = await authorizeRequest(request, dependencies.auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ data: null, error: 'Invalid queue filters' });
    const query = parsed.data;
    if (Boolean(query.beforeScheduledAt) !== Boolean(query.beforeId))
      return reply.code(400).send({ data: null, error: 'Incomplete queue cursor' });
    const rows = await listBrowserJobSummaries(dependencies.database, {
      workspaceId: identity.workspaceId,
      limit: query.limit + 1,
      ...(query.states ? { states: query.states } : {}),
      ...(query.providerAccountId ? { providerAccountId: query.providerAccountId } : {}),
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
    const params = z.object({ jobId: z.uuid() }).safeParse(request.params);
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
}
