import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  postRevisions,
  posts,
  providerAccounts,
  providerConnections,
  publicationJobs,
  revisionMedia,
} from '../../database/schema.js';
import { PostNotFoundError, PostValidationError } from './post.errors.js';
import { resolveYouTubeSettings } from '../providers/youtube-settings.js';
import { validateLinkedInTextContent } from '../providers/linkedin-content.js';

export interface PostRevisionInput {
  content: Record<string, unknown>;
  mediaIds: readonly string[];
  providerAccountIds: readonly string[];
  scheduledAt: Date;
  actor?: { type: 'user' | 'api-key' | 'delegated'; id: string };
}

function persistedActor(actor: PostRevisionInput['actor'], userId?: string) {
  const resolved = actor ?? (userId ? { type: 'user' as const, id: userId } : undefined);
  return resolved
    ? {
        type:
          resolved.type === 'api-key'
            ? ('api_key' as const)
            : resolved.type === 'delegated'
              ? ('delegated' as const)
              : ('user' as const),
        id: resolved.id,
      }
    : { type: null, id: null };
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
  const media = await database.execute<{ id: string }>(sql`
    select id from media_objects
    where workspace_id = ${input.workspaceId}
      and id in (${sql.join(
        input.mediaIds.map((mediaId) => sql`${mediaId}`),
        sql`, `,
      )})
      and state in ('ready', 'cleanup_eligible', 'cleanup_failed')
    order by id
    for update
  `);
  if (media.rows.length !== input.mediaIds.length)
    throw new PostValidationError('One or more media objects do not belong to the workspace');
  await database.execute(sql`
    update media_objects
    set state = 'ready', cleanup_eligible_at = null, cleanup_started_at = null,
      cleanup_retry_at = null, updated_at = now()
    where workspace_id = ${input.workspaceId}
      and id in (${sql.join(
        input.mediaIds.map((mediaId) => sql`${mediaId}`),
        sql`, `,
      )})
      and state in ('cleanup_eligible', 'cleanup_failed')
  `);
}

async function createRevisionTargets(
  database: NodePgDatabase,
  input: PostRevisionInput & {
    workspaceId: string;
    userId?: string;
    postId: string;
    revisionNumber: number;
  },
): Promise<{ revisionId: string; jobIds: string[] }> {
  const accountRows = await database
    .select({
      id: providerAccounts.id,
      provider: providerConnections.provider,
      status: providerConnections.status,
      expiresAt: providerConnections.expiresAt,
      disconnectedAt: providerAccounts.disconnectedAt,
      adapterDefaults: providerAccounts.adapterDefaults,
    })
    .from(providerAccounts)
    .innerJoin(providerConnections, eq(providerConnections.id, providerAccounts.connectionId))
    .where(
      and(
        eq(providerAccounts.workspaceId, input.workspaceId),
        inArray(providerAccounts.id, input.providerAccountIds),
      ),
    );
  const accountsById = new Map(accountRows.map((account) => [account.id, account]));
  const effectiveSettings = new Map(
    input.providerAccountIds.map((accountId) => {
      const account = accountsById.get(accountId);
      if (!account) throw new PostValidationError('Provider account is unavailable');
      if (account.provider === 'linkedin') {
        if (
          account.status !== 'active' ||
          account.disconnectedAt ||
          !account.expiresAt ||
          account.expiresAt <= input.scheduledAt
        )
          throw new PostValidationError(
            'Reconnect LinkedIn before scheduling beyond its token expiry',
          );
        try {
          validateLinkedInTextContent(input.content, input.mediaIds);
        } catch (error) {
          throw new PostValidationError(
            error instanceof Error ? error.message : 'Invalid LinkedIn content',
          );
        }
        return [accountId, null] as const;
      }
      if (account.provider !== 'youtube') return [accountId, null] as const;
      const content = input.content as {
        kind?: unknown;
        providerOptions?: { youtube?: unknown };
      };
      if (content.kind !== 'video') throw new PostValidationError('YouTube requires video content');
      try {
        return [
          accountId,
          resolveYouTubeSettings(account.adapterDefaults, content.providerOptions?.youtube),
        ] as const;
      } catch (error) {
        throw new PostValidationError(
          error instanceof Error ? error.message : 'Invalid YouTube settings',
        );
      }
    }),
  );
  const actor = persistedActor(input.actor, input.userId);
  const revisions = await database
    .insert(postRevisions)
    .values({
      workspaceId: input.workspaceId,
      postId: input.postId,
      revisionNumber: input.revisionNumber,
      content: input.content,
      createdActorType: actor.type,
      createdActorId: actor.id,
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
        effectiveProviderSettings: effectiveSettings.get(providerAccountId),
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
  const actor = persistedActor(input.actor, input.userId);
  await validateTargetOwnership(database, input);
  const rows = await database
    .insert(posts)
    .values({
      workspaceId: input.workspaceId,
      createdByUserId: input.userId,
      createdActorType: actor.type,
      createdActorId: actor.id,
      lastMutatorType: actor.type,
      lastMutatorId: actor.id,
    })
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
  input: PostRevisionInput & {
    workspaceId: string;
    userId?: string;
    postId: string;
    now: Date;
    expectedSupersededJobCount?: number;
  },
): Promise<{ postId: string; revisionId: string; jobIds: string[]; supersededJobIds: string[] }> {
  const actor = persistedActor(input.actor, input.userId);
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
  if (
    input.expectedSupersededJobCount !== undefined &&
    superseded.length !== input.expectedSupersededJobCount
  )
    throw new PostValidationError('Schedule changed after dispatch started; no changes were saved');
  const targets = await createRevisionTargets(database, {
    ...input,
    revisionNumber: current.revisionNumber + 1,
  });
  await database
    .update(posts)
    .set({ updatedAt: input.now, lastMutatorType: actor.type, lastMutatorId: actor.id })
    .where(and(eq(posts.workspaceId, input.workspaceId), eq(posts.id, input.postId)));
  return {
    postId: input.postId,
    ...targets,
    supersededJobIds: superseded.map((job) => job.id),
  };
}

export async function reschedulePostIntent(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    userId?: string;
    actor?: { type: 'user' | 'api-key' | 'delegated'; id: string };
    postId: string;
    scheduledAt: Date;
    now: Date;
  },
): Promise<{ postId: string; revisionId: string; jobIds: string[]; supersededJobIds: string[] }> {
  const revisions = await database
    .select({ id: postRevisions.id, content: postRevisions.content })
    .from(postRevisions)
    .where(
      and(eq(postRevisions.workspaceId, input.workspaceId), eq(postRevisions.postId, input.postId)),
    )
    .orderBy(desc(postRevisions.revisionNumber))
    .limit(1);
  const revision = revisions[0];
  if (!revision) throw new PostNotFoundError('Post not found in workspace');
  // Scheduler claims lock the same rows with FOR UPDATE SKIP LOCKED. Holding these
  // locks through supersession makes the pre-dispatch check atomic with claiming.
  const jobs = await database
    .select({
      providerAccountId: publicationJobs.providerAccountId,
      state: publicationJobs.state,
    })
    .from(publicationJobs)
    .where(
      and(
        eq(publicationJobs.workspaceId, input.workspaceId),
        eq(publicationJobs.revisionId, revision.id),
      ),
    )
    .for('update');
  if (jobs.length === 0 || jobs.some((job) => job.state !== 'scheduled'))
    throw new PostValidationError('Schedule can only be edited before every target dispatches');
  const media = await database
    .select({ id: revisionMedia.mediaId })
    .from(revisionMedia)
    .where(
      and(
        eq(revisionMedia.workspaceId, input.workspaceId),
        eq(revisionMedia.revisionId, revision.id),
      ),
    )
    .orderBy(asc(revisionMedia.position));
  return revisePostIntent(database, {
    ...input,
    content: revision.content as Record<string, unknown>,
    mediaIds: media.map((item) => item.id),
    providerAccountIds: jobs.map((job) => job.providerAccountId),
    expectedSupersededJobCount: jobs.length,
  });
}
