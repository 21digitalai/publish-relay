import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  postRevisions,
  posts,
  providerAccounts,
  providerConnections,
  publicationJobs,
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
  limit: number;
  states?: BrowserJobState[];
  providerAccountId?: string;
  before?: { scheduledAt: Date; id: string };
}

const browserJobProjection = {
  id: publicationJobs.id,
  postId: publicationJobs.postId,
  state: publicationJobs.state,
  scheduledAt: publicationJobs.scheduledAt,
  createdAt: publicationJobs.createdAt,
  updatedAt: publicationJobs.updatedAt,
  content: postRevisions.content,
  providerAccount: {
    id: providerAccounts.id,
    displayName: providerAccounts.displayName,
    handle: providerAccounts.providerAccountId,
    provider: providerConnections.provider,
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
      providerAccounts,
      and(
        eq(providerAccounts.workspaceId, publicationJobs.workspaceId),
        eq(providerAccounts.id, publicationJobs.providerAccountId),
      ),
    )
    .innerJoin(providerConnections, eq(providerConnections.id, providerAccounts.connectionId));
}

export async function listBrowserJobSummaries(
  database: NodePgDatabase,
  input: BrowserJobFilters,
) {
  const cursor = input.before
    ? or(
        lt(publicationJobs.scheduledAt, input.before.scheduledAt),
        and(
          eq(publicationJobs.scheduledAt, input.before.scheduledAt),
          lt(publicationJobs.id, input.before.id),
        ),
      )
    : undefined;
  return withTenantTransaction(database, { workspaceId: input.workspaceId }, (transaction) =>
    browserJobJoins(transaction)
      .where(
        and(
          eq(publicationJobs.workspaceId, input.workspaceId),
          input.states?.length ? inArray(publicationJobs.state, input.states) : undefined,
          input.providerAccountId
            ? eq(publicationJobs.providerAccountId, input.providerAccountId)
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
) {
  const rows = await withTenantTransaction(database, { workspaceId }, (transaction) =>
    browserJobJoins(transaction)
      .where(and(eq(publicationJobs.workspaceId, workspaceId), eq(publicationJobs.id, jobId)))
      .limit(1),
  );
  return rows[0] ?? null;
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
  return database
    .select({ id: posts.id, createdAt: posts.createdAt, updatedAt: posts.updatedAt })
    .from(posts)
    .where(and(eq(posts.workspaceId, input.workspaceId), cursor))
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(input.limit);
}

export async function getPostDetail(database: NodePgDatabase, workspaceId: string, postId: string) {
  const rows = await database
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
  const jobs = await database
    .select({
      id: publicationJobs.id,
      state: publicationJobs.state,
      scheduledAt: publicationJobs.scheduledAt,
    })
    .from(publicationJobs)
    .where(and(eq(publicationJobs.workspaceId, workspaceId), eq(publicationJobs.postId, postId)))
    .orderBy(desc(publicationJobs.createdAt), desc(publicationJobs.id));
  return { ...post, jobs };
}

export async function getJobDetail(database: NodePgDatabase, workspaceId: string, jobId: string) {
  const rows = await database
    .select({
      id: publicationJobs.id,
      postId: publicationJobs.postId,
      revisionId: publicationJobs.revisionId,
      state: publicationJobs.state,
      scheduledAt: publicationJobs.scheduledAt,
      createdAt: publicationJobs.createdAt,
      updatedAt: publicationJobs.updatedAt,
    })
    .from(publicationJobs)
    .where(and(eq(publicationJobs.workspaceId, workspaceId), eq(publicationJobs.id, jobId)))
    .limit(1);
  return rows[0] ?? null;
}
