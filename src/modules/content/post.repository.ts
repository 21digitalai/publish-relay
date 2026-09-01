import { and, desc, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  mediaObjects,
  postRevisions,
  posts,
  providerAccounts,
  publicationJobs,
  revisionMedia,
} from '../../database/schema.js';
import { PostNotFoundError, PostValidationError } from './post.errors.js';

export interface PostRevisionInput {
  content: Record<string, unknown>;
  mediaIds: readonly string[];
  providerAccountIds: readonly string[];
  scheduledAt: Date;
}

async function validateTargetOwnership(
  database: NodePgDatabase,
  input: Pick<PostRevisionInput, 'mediaIds' | 'providerAccountIds'> & { workspaceId: string },
): Promise<void> {
  const accounts = await database
    .select({ id: providerAccounts.id })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.workspaceId, input.workspaceId),
        inArray(providerAccounts.id, input.providerAccountIds),
      ),
    );
  if (accounts.length !== input.providerAccountIds.length)
    throw new PostValidationError('One or more provider accounts do not belong to the workspace');
  if (input.mediaIds.length === 0) return;
  const media = await database
    .select({ id: mediaObjects.id })
    .from(mediaObjects)
    .where(
      and(
        eq(mediaObjects.workspaceId, input.workspaceId),
        inArray(mediaObjects.id, input.mediaIds),
      ),
    );
  if (media.length !== input.mediaIds.length)
    throw new PostValidationError('One or more media objects do not belong to the workspace');
}

async function createRevisionTargets(
  database: NodePgDatabase,
  input: PostRevisionInput & { workspaceId: string; postId: string; revisionNumber: number },
): Promise<{ revisionId: string; jobIds: string[] }> {
  const revisions = await database
    .insert(postRevisions)
    .values({
      workspaceId: input.workspaceId,
      postId: input.postId,
      revisionNumber: input.revisionNumber,
      content: input.content,
    })
    .returning({ id: postRevisions.id });
  const revision = revisions[0];
  if (!revision) throw new Error('Post revision write returned no record');
  if (input.mediaIds.length > 0)
    await database.insert(revisionMedia).values(
      input.mediaIds.map((mediaId, position) => ({
        workspaceId: input.workspaceId,
        revisionId: revision.id,
        mediaId,
        position,
      })),
    );
  const jobs = await database
    .insert(publicationJobs)
    .values(
      input.providerAccountIds.map((providerAccountId) => ({
        workspaceId: input.workspaceId,
        postId: input.postId,
        revisionId: revision.id,
        providerAccountId,
        scheduledAt: input.scheduledAt,
      })),
    )
    .returning({ id: publicationJobs.id });
  return { revisionId: revision.id, jobIds: jobs.map((job) => job.id) };
}

export async function createPostIntent(
  database: NodePgDatabase,
  input: PostRevisionInput & { workspaceId: string; userId: string },
): Promise<{ postId: string; revisionId: string; jobIds: string[] }> {
  await validateTargetOwnership(database, input);
  const rows = await database
    .insert(posts)
    .values({ workspaceId: input.workspaceId, createdByUserId: input.userId })
    .returning({ id: posts.id });
  const post = rows[0];
  if (!post) throw new Error('Post write returned no record');
  const targets = await createRevisionTargets(database, {
    ...input,
    postId: post.id,
    revisionNumber: 1,
  });
  return { postId: post.id, ...targets };
}

export async function revisePostIntent(
  database: NodePgDatabase,
  input: PostRevisionInput & { workspaceId: string; postId: string; now: Date },
): Promise<{ postId: string; revisionId: string; jobIds: string[]; supersededJobIds: string[] }> {
  await validateTargetOwnership(database, input);
  const existing = await database
    .select({ revisionNumber: postRevisions.revisionNumber })
    .from(postRevisions)
    .where(
      and(eq(postRevisions.workspaceId, input.workspaceId), eq(postRevisions.postId, input.postId)),
    )
    .orderBy(desc(postRevisions.revisionNumber))
    .limit(1);
  const current = existing[0];
  if (!current) throw new PostNotFoundError('Post not found in workspace');
  const superseded = await database
    .update(publicationJobs)
    .set({ state: 'superseded', supersededAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(publicationJobs.workspaceId, input.workspaceId),
        eq(publicationJobs.postId, input.postId),
        inArray(publicationJobs.state, ['scheduled']),
      ),
    )
    .returning({ id: publicationJobs.id });
  const targets = await createRevisionTargets(database, {
    ...input,
    revisionNumber: current.revisionNumber + 1,
  });
  await database
    .update(posts)
    .set({ updatedAt: input.now })
    .where(and(eq(posts.workspaceId, input.workspaceId), eq(posts.id, input.postId)));
  return {
    postId: input.postId,
    ...targets,
    supersededJobIds: superseded.map((job) => job.id),
  };
}
