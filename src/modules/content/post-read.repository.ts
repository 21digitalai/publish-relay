import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  postRevisions,
  posts,
  publicationAttempts,
  publicationJobEvents,
  publicationJobs,
  mediaObjects,
  revisionMedia,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export const browserJobStates = [
  'scheduled',
  'leased',
  'dispatching',
  'published',
  'accepted_pending',
  'retry_wait',
  'failed',
  'cancelled',
  'superseded',
] as const;

export type BrowserJobState = (typeof browserJobStates)[number];

export interface BrowserJobFilters {
  workspaceId: string;
  userId?: string;
  limit: number;
  states?: BrowserJobState[];
  providerAccountId?: string;
  scheduledAfter?: Date;
  scheduledBefore?: Date;
  before?: { scheduledAt: Date; id: string };
}

const browserJobProjection = {
  id: publicationJobs.id,
  postId: publicationJobs.postId,
  state: publicationJobs.state,
  scheduledAt: publicationJobs.scheduledAt,
  createdAt: publicationJobs.createdAt,
  updatedAt: publicationJobs.updatedAt,
  effectivePayload: publicationJobs.effectivePayload,
  effectiveProviderSettings: publicationJobs.effectiveProviderSettings,
  content: postRevisions.content,
  revisionId: postRevisions.id,
  mediaCount: sql<number>`(
    select count(*)::int from revision_media summary_media
    where summary_media.workspace_id = ${publicationJobs.workspaceId}
      and summary_media.revision_id = ${postRevisions.id}
  )`,
  previewMediaId: sql<string | null>`(
    select summary_object.id::text
    from revision_media summary_media
    inner join media_objects summary_object
      on summary_object.workspace_id = summary_media.workspace_id
      and summary_object.id = summary_media.media_id
    where summary_media.workspace_id = ${publicationJobs.workspaceId}
      and summary_media.revision_id = ${postRevisions.id}
      and summary_object.state = 'ready'
    order by summary_media.position asc
    limit 1
  )`,
  creator: {
    type: posts.createdActorType,
    id: posts.createdActorId,
    label: sql<string | null>`case
      when ${posts.createdActorType} = 'user' then
        (select display_name from users where id = ${posts.createdActorId})
      when ${posts.createdActorType} = 'api_key' then
        (select label from api_keys where workspace_id = ${posts.workspaceId} and id = ${posts.createdActorId})
      else null end`,
  },
  lastMutator: {
    type: posts.lastMutatorType,
    id: posts.lastMutatorId,
    label: sql<string | null>`case
      when ${posts.lastMutatorType} = 'user' then
        (select display_name from users where id = ${posts.lastMutatorId})
      when ${posts.lastMutatorType} = 'api_key' then
        (select label from api_keys where workspace_id = ${posts.workspaceId} and id = ${posts.lastMutatorId})
      else null end`,
  },
  providerAccount: {
    id: sql<string>`browser_account.id`,
    displayName: sql<string>`browser_account.display_name`,
    handle: sql<string | null>`browser_account.handle`,
    provider: sql<string>`browser_account.provider`,
    originWorkspaceName: sql<string | null>`browser_account.origin_workspace_name`,
  },
};

function browserJobJoins(database: NodePgDatabase) {
  return database
    .select(browserJobProjection)
    .from(publicationJobs)
    .innerJoin(
      postRevisions,
      and(
        eq(postRevisions.workspaceId, publicationJobs.workspaceId),
        eq(postRevisions.id, publicationJobs.revisionId),
      ),
    )
    .innerJoin(
      posts,
      and(eq(posts.workspaceId, publicationJobs.workspaceId), eq(posts.id, publicationJobs.postId)),
    )
    .innerJoin(
      sql`LATERAL public.resolve_browser_job_account(
        ${publicationJobs.workspaceId}, ${publicationJobs.id}
      ) AS browser_account`,
      sql`true`,
    );
}

export async function listBrowserJobSummaries(database: NodePgDatabase, input: BrowserJobFilters) {
  const cursor = input.before
    ? or(
        lt(publicationJobs.scheduledAt, input.before.scheduledAt),
        and(
          eq(publicationJobs.scheduledAt, input.before.scheduledAt),
          lt(publicationJobs.id, input.before.id),
        ),
      )
    : undefined;
  return withTenantTransaction(database, {
    workspaceId: input.workspaceId,
    ...(input.userId ? { userId: input.userId } : {}),
  }, (transaction) =>
    browserJobJoins(transaction)
      .where(
        and(
          eq(publicationJobs.workspaceId, input.workspaceId),
          input.states?.length ? inArray(publicationJobs.state, input.states) : undefined,
          input.providerAccountId
            ? eq(publicationJobs.providerAccountId, input.providerAccountId)
            : undefined,
          input.scheduledAfter ? gte(publicationJobs.scheduledAt, input.scheduledAfter) : undefined,
          input.scheduledBefore
            ? lte(publicationJobs.scheduledAt, input.scheduledBefore)
            : undefined,
          cursor,
        ),
      )
      .orderBy(desc(publicationJobs.scheduledAt), desc(publicationJobs.id))
      .limit(input.limit),
  );
}

export async function getBrowserJobDetail(
  database: NodePgDatabase,
  workspaceId: string,
  jobId: string,
  userId?: string,
) {
  return withTenantTransaction(database, {
    workspaceId,
    ...(userId ? { userId } : {}),
  }, async (transaction) => {
    const rows = await browserJobJoins(transaction)
      .where(and(eq(publicationJobs.workspaceId, workspaceId), eq(publicationJobs.id, jobId)))
      .limit(1);
    const job = rows[0];
    if (!job) return null;
    const [media, attempts, activity] = await Promise.all([
      transaction
        .select({
          id: mediaObjects.id,
          position: revisionMedia.position,
          mimeType: mediaObjects.mimeType,
          byteSize: mediaObjects.byteSize,
          sha256: mediaObjects.sha256,
          state: mediaObjects.state,
        })
        .from(revisionMedia)
        .innerJoin(
          mediaObjects,
          and(
            eq(mediaObjects.workspaceId, revisionMedia.workspaceId),
            eq(mediaObjects.id, revisionMedia.mediaId),
          ),
        )
        .where(
          and(
            eq(revisionMedia.workspaceId, workspaceId),
            eq(revisionMedia.revisionId, job.revisionId),
          ),
        )
        .orderBy(asc(revisionMedia.position)),
      transaction
        .select({
          id: publicationAttempts.id,
          attemptNumber: publicationAttempts.attemptNumber,
          startedAt: publicationAttempts.startedAt,
          finishedAt: publicationAttempts.finishedAt,
          outcome: publicationAttempts.outcome,
          externalPostId: publicationAttempts.externalPostId,
          retryAt: publicationAttempts.retryAt,
          error: publicationAttempts.redactedError,
        })
        .from(publicationAttempts)
        .where(
          and(
            eq(publicationAttempts.workspaceId, workspaceId),
            eq(publicationAttempts.jobId, jobId),
          ),
        )
        .orderBy(asc(publicationAttempts.attemptNumber)),
      transaction
        .select({
          id: publicationJobEvents.id,
          fromState: publicationJobEvents.fromState,
          toState: publicationJobEvents.toState,
          reason: publicationJobEvents.reason,
          createdAt: publicationJobEvents.createdAt,
        })
        .from(publicationJobEvents)
        .where(
          and(
            eq(publicationJobEvents.workspaceId, workspaceId),
            eq(publicationJobEvents.jobId, jobId),
          ),
        )
        .orderBy(asc(publicationJobEvents.createdAt), asc(publicationJobEvents.id)),
    ]);
    const published = [...attempts].reverse().find((attempt) => attempt.externalPostId);
    const externalUrl = published?.externalPostId
      ? job.providerAccount.provider === 'x' && job.providerAccount.handle
        ? `https://x.com/${job.providerAccount.handle}/status/${published.externalPostId}`
        : job.providerAccount.provider === 'youtube'
          ? `https://www.youtube.com/watch?v=${published.externalPostId}`
          : job.providerAccount.provider === 'linkedin'
            ? `https://www.linkedin.com/feed/update/${encodeURIComponent(published.externalPostId)}/`
            : null
      : null;
    return {
      ...job,
      media: media.map((item) => ({
        ...item,
        previewUrl: item.state === 'ready' ? `/api/workflow/media/${item.id}` : null,
      })),
      attempts,
      activity,
      providerResult: published ? { id: published.externalPostId, url: externalUrl } : null,
    };
  });
}

export interface PostSummary {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function listPostSummaries(
  database: NodePgDatabase,
  input: { workspaceId: string; limit: number; before?: { createdAt: Date; id: string } },
): Promise<PostSummary[]> {
  const cursor = input.before
    ? or(
        lt(posts.createdAt, input.before.createdAt),
        and(eq(posts.createdAt, input.before.createdAt), lt(posts.id, input.before.id)),
      )
    : undefined;
  return withTenantTransaction(database, { workspaceId: input.workspaceId }, (transaction) =>
    transaction
      .select({ id: posts.id, createdAt: posts.createdAt, updatedAt: posts.updatedAt })
      .from(posts)
      .where(and(eq(posts.workspaceId, input.workspaceId), cursor))
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(input.limit),
  );
}

export async function getPostDetail(database: NodePgDatabase, workspaceId: string, postId: string) {
  return withTenantTransaction(database, { workspaceId }, async (transaction) => {
    const rows = await transaction
      .select({
        id: posts.id,
        createdAt: posts.createdAt,
        updatedAt: posts.updatedAt,
        revisionId: postRevisions.id,
        revisionNumber: postRevisions.revisionNumber,
      })
      .from(posts)
      .innerJoin(
        postRevisions,
        and(eq(postRevisions.workspaceId, posts.workspaceId), eq(postRevisions.postId, posts.id)),
      )
      .where(and(eq(posts.workspaceId, workspaceId), eq(posts.id, postId)))
      .orderBy(desc(postRevisions.revisionNumber))
      .limit(1);
    const post = rows[0];
    if (!post) return null;
    const jobs = await transaction
      .select({
        id: publicationJobs.id,
        state: publicationJobs.state,
        scheduledAt: publicationJobs.scheduledAt,
      })
      .from(publicationJobs)
      .where(and(eq(publicationJobs.workspaceId, workspaceId), eq(publicationJobs.postId, postId)))
      .orderBy(desc(publicationJobs.createdAt), desc(publicationJobs.id));
    return { ...post, jobs };
  });
}

export async function getJobDetail(database: NodePgDatabase, workspaceId: string, jobId: string) {
  return getBrowserJobDetail(database, workspaceId, jobId);
}
