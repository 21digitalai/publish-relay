import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  postRevisions,
  posts,
  mediaObjects,
  publicationJobs,
  revisionMedia,
} from '../../database/schema.js';
import { loadPostAccounts } from './exposed-post-accounts.js';
import { PostNotFoundError, PostValidationError } from './post.errors.js';
import { normalizeFacebookPhaseOneContent } from '../providers/facebook-content.js';
import { hasExactInstagramLoginScopes } from '../providers/instagram-login-client.js';
import { validateLinkedInTextContent } from '../providers/linkedin-content.js';
import { publicationSettingsRegistry } from '../providers/publication-settings-registry.js';
import type { DestinationProvider } from '../providers/contract.js';
import {
  validateXPostLength,
  weightedXPostLength,
  xPostTexts,
  X_DECLARED_LONG_POST_LIMIT,
  X_STANDARD_POST_LIMIT,
} from '../providers/x-text-length.js';

export function buildMetaEffectivePayload(
  destinationProvider: string,
  availability: string,
  content: Record<string, unknown>,
  mediaIds: readonly string[],
  mediaMimeTypes: readonly string[],
): Record<string, unknown> {
  if (availability !== 'active')
    throw new PostValidationError(`Destination is unavailable: ${availability}`);
  const kind = content.kind;
  const text = typeof content.text === 'string' ? content.text.trim() : '';
  if (!mediaMimeTypes.every((mimeType) => mimeType.startsWith('image/')))
    throw new PostValidationError('Meta phase one accepts image media only');
  if (destinationProvider === 'instagram') {
    if (kind === 'single_image' && mediaIds.length !== 1)
      throw new PostValidationError('Instagram single image requires exactly one image');
    if (kind === 'carousel' && (mediaIds.length < 2 || mediaIds.length > 10))
      throw new PostValidationError('Instagram carousel requires 2 to 10 images');
    if (kind !== 'single_image' && kind !== 'carousel')
      throw new PostValidationError('Instagram supports single image or carousel content');
    return { schemaVersion: 1, destinationProvider, kind, caption: text, mediaIds: [...mediaIds] };
  }
  if (destinationProvider === 'facebook_page') {
    try {
      const normalized = normalizeFacebookPhaseOneContent({
        kind,
        message: content.text,
        linkUrl: content.linkUrl,
        mediaMimeTypes,
      });
      return {
        schemaVersion: 1,
        destinationProvider,
        ...normalized,
        ...(normalized.kind === 'single_image' ? { mediaIds: [...mediaIds] } : {}),
      };
    } catch (error) {
      throw new PostValidationError(
        error instanceof Error ? error.message : 'Invalid Facebook content',
      );
    }
  }
  throw new PostValidationError('Unsupported Meta destination');
}

export interface PostRevisionInput {
  content: Record<string, unknown>;
  mediaIds: readonly string[];
  providerAccountIds: readonly string[];
  selectedDestination?: string;
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
  input: Pick<
    PostRevisionInput,
    'content' | 'mediaIds' | 'providerAccountIds' | 'selectedDestination'
  > & {
    workspaceId: string;
    xMediaPresent?: boolean;
  },
  validateXText = true,
  readOnly = false,
): Promise<{ id: string; destinationProvider: string; xLongPostsAllowed: boolean }[]> {
  // Cross-workspace admission reserves origin then target; the privileged projection
  // rechecks the active exposure after those locks and before target-owned writes.
  const accounts = await loadPostAccounts(
    database,
    input.workspaceId,
    input.providerAccountIds,
    !readOnly,
  );
  if (accounts.length !== input.providerAccountIds.length)
    throw new PostValidationError('One or more provider accounts do not belong to the workspace');
  if (accounts.some((account) => account.destinationProvider === 'tiktok'))
    throw new PostValidationError('TikTok publishing is not available in this release');
  if (
    input.selectedDestination &&
    accounts.some((account) => account.destinationProvider !== input.selectedDestination)
  )
    throw new PostValidationError('Selected provider does not match the connected destination');
  if (accounts.some((account) => account.connectionStatus === 'revoking'))
    throw new PostValidationError(
      'Meta grant revocation is pending; retry revoke before scheduling',
    );
  if (
    accounts.some(
      (account) => account.disconnectedAt !== null || account.connectionStatus !== 'active',
    )
  )
    throw new PostValidationError('One or more provider accounts are disconnected');
  for (const account of accounts) {
    if (account.destinationProvider !== 'x' || !validateXText) continue;
    try {
      validateXPostLength(
        input.content,
        account.xLongPostsAllowed,
        input.mediaIds,
        input.xMediaPresent,
      );
    } catch (error) {
      throw new PostValidationError(error instanceof Error ? error.message : 'Invalid X post text');
    }
  }
  if (input.mediaIds.length === 0) return accounts;
  const media = await database.execute<{ id: string }>(sql`
    select id from media_objects
    where workspace_id = ${input.workspaceId}
      and id in (${sql.join(
        input.mediaIds.map((mediaId) => sql`${mediaId}`),
        sql`, `,
      )})
      and state in ('ready', 'cleanup_eligible', 'cleanup_failed')
    order by id
    ${readOnly ? sql`` : sql`for update`}
  `);
  if (media.rows.length !== input.mediaIds.length)
    throw new PostValidationError('One or more media objects do not belong to the workspace');
  if (!readOnly)
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
  return accounts;
}

async function resolveRevisionTargets(
  database: NodePgDatabase,
  input: PostRevisionInput & { workspaceId: string },
) {
  const accountRows = await loadPostAccounts(
    database,
    input.workspaceId,
    input.providerAccountIds,
    false,
  );
  const accountsById = new Map(accountRows.map((account) => [account.id, account]));
  const mediaRows =
    input.mediaIds.length === 0
      ? []
      : await database
          .select({ id: mediaObjects.id, mimeType: mediaObjects.mimeType })
          .from(mediaObjects)
          .where(
            and(
              eq(mediaObjects.workspaceId, input.workspaceId),
              inArray(mediaObjects.id, input.mediaIds),
            ),
          );
  const mediaMimeTypes = input.mediaIds.map(
    (mediaId) => mediaRows.find((media) => media.id === mediaId)?.mimeType ?? '',
  );
  const effectivePayloads = new Map(
    input.providerAccountIds.map((accountId) => {
      const account = accountsById.get(accountId);
      if (!account) throw new PostValidationError('Provider account is unavailable');
      if (account.provider !== 'meta' && account.provider !== 'instagram_login')
        return [accountId, null] as const;
      if (account.provider === 'instagram_login') {
        if (
          account.destinationProvider !== 'instagram' ||
          !hasExactInstagramLoginScopes(account.scopes) ||
          !account.accessExpiresAt ||
          account.accessExpiresAt <= new Date()
        )
          throw new PostValidationError('Instagram Login grant is unavailable');
        if (mediaMimeTypes.some((mimeType) => mimeType !== 'image/jpeg'))
          throw new PostValidationError('Instagram Login currently accepts JPEG images only');
      }
      return [
        accountId,
        buildMetaEffectivePayload(
          account.destinationProvider,
          account.availability,
          input.content,
          input.mediaIds,
          mediaMimeTypes,
        ),
      ] as const;
    }),
  );
  const effectiveSettings = new Map(
    input.providerAccountIds.map((accountId) => {
      const account = accountsById.get(accountId);
      if (!account) throw new PostValidationError('Provider account is unavailable');
      if (account.provider === 'linkedin') {
        if (
          account.connectionStatus !== 'active' ||
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
      try {
        const resolver = publicationSettingsRegistry.find(
          account.destinationProvider as DestinationProvider,
        );
        return [
          accountId,
          resolver?.resolve(input.content, account.adapterDefaults) ?? null,
        ] as const;
      } catch (error) {
        throw new PostValidationError(
          error instanceof Error ? error.message : 'Invalid YouTube settings',
        );
      }
    }),
  );
  return { effectivePayloads, effectiveSettings };
}

export async function validatePostTargets(
  database: NodePgDatabase,
  input: PostRevisionInput & { workspaceId: string; xMediaPresent?: boolean },
): Promise<
  {
    providerAccountId: string;
    valid: boolean;
    error?: string;
    weightedLength?: number;
    limit?: number;
  }[]
> {
  const results = [];
  for (const providerAccountId of input.providerAccountIds) {
    const target = { ...input, providerAccountIds: [providerAccountId] };
    let account: { destinationProvider: string; xLongPostsAllowed: boolean } | undefined;
    try {
      const accounts = await validateTargetOwnership(database, target, true, true);
      account = accounts[0];
      if (input.xMediaPresent && account?.destinationProvider !== 'x')
        throw new PostValidationError('X media preview requires an X destination');
      await resolveRevisionTargets(database, target);
      const lengths =
        account?.destinationProvider === 'x'
          ? xPostTexts(input.content, input.mediaIds, input.xMediaPresent).map(weightedXPostLength)
          : [];
      results.push({
        providerAccountId,
        valid: true,
        ...(lengths.length
          ? {
              weightedLength: Math.max(...lengths),
              limit: account?.xLongPostsAllowed
                ? X_DECLARED_LONG_POST_LIMIT
                : X_STANDARD_POST_LIMIT,
            }
          : {}),
      });
    } catch (error) {
      if (!(error instanceof PostValidationError)) throw error;
      const message = error.message;
      const xLength =
        /^X post text is (\d+) weighted characters; selected account limit is (\d+)$/.exec(message);
      results.push({
        providerAccountId,
        valid: false,
        error: message,
        ...(xLength ? { weightedLength: Number(xLength[1]), limit: Number(xLength[2]) } : {}),
      });
    }
  }
  return results;
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
  const { effectivePayloads, effectiveSettings } = await resolveRevisionTargets(database, input);
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
        effectivePayload: effectivePayloads.get(providerAccountId),
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
  await validateTargetOwnership(database, input);
  const postId = await createPostRow(database, input);
  const targets = await createRevisionTargets(database, {
    ...input,
    postId,
    revisionNumber: 1,
  });
  return { postId, ...targets };
}

async function createPostRow(
  database: NodePgDatabase,
  input: { workspaceId: string; userId: string; actor?: PostRevisionInput['actor'] },
): Promise<string> {
  const actor = persistedActor(input.actor, input.userId);
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
  return post.id;
}

export async function createUnscheduledPostRevision(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    userId: string;
    actor?: PostRevisionInput['actor'];
    content: Record<string, unknown>;
    mediaId: string;
  },
): Promise<{ postId: string; revisionId: string }> {
  const postId = await createPostRow(database, input);
  const actor = persistedActor(input.actor, input.userId);
  const revisions = await database
    .insert(postRevisions)
    .values({
      workspaceId: input.workspaceId,
      postId,
      revisionNumber: 1,
      content: input.content,
      createdActorType: actor.type,
      createdActorId: actor.id,
    })
    .returning({ id: postRevisions.id });
  const revisionId = revisions[0]?.id;
  if (!revisionId) throw new Error('Post revision write returned no record');
  await database.insert(revisionMedia).values({
    workspaceId: input.workspaceId,
    revisionId,
    mediaId: input.mediaId,
    position: 0,
  });
  return { postId, revisionId };
}

export async function schedulePreparedTikTokRevision(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    postId: string;
    revisionId: string;
    accountId: string;
    scheduledAt: Date;
    effectivePayload: Record<string, unknown>;
    actorId: string;
  },
): Promise<string> {
  const existing = await database.execute(sql`
    select p.id from posts p where p.workspace_id = ${input.workspaceId}
      and p.id = ${input.postId} for update
  `);
  if (existing.rows.length !== 1) throw new PostValidationError('TikTok draft is unavailable');
  const revision = await database.execute(sql`
    select id from post_revisions where workspace_id = ${input.workspaceId}
      and post_id = ${input.postId} order by revision_number desc limit 1
  `);
  if (revision.rows[0]?.id !== input.revisionId)
    throw new PostValidationError('TikTok draft revision changed');
  const jobs = await database.execute(sql`
    select id from publication_jobs where workspace_id = ${input.workspaceId}
      and post_id = ${input.postId} limit 1
  `);
  if (jobs.rows.length) throw new PostValidationError('TikTok draft is already scheduled');
  const inserted = await database
    .insert(publicationJobs)
    .values({
      workspaceId: input.workspaceId,
      postId: input.postId,
      revisionId: input.revisionId,
      providerAccountId: input.accountId,
      effectivePayload: input.effectivePayload,
      scheduledAt: input.scheduledAt,
    })
    .returning({ id: publicationJobs.id });
  await database
    .update(posts)
    .set({
      updatedAt: new Date(),
      lastMutatorType: 'user',
      lastMutatorId: input.actorId,
    })
    .where(and(eq(posts.workspaceId, input.workspaceId), eq(posts.id, input.postId)));
  const id = inserted[0]?.id;
  if (!id) throw new Error('TikTok schedule returned no job');
  return id;
}

async function revisePostIntentInternal(
  database: NodePgDatabase,
  input: PostRevisionInput & {
    workspaceId: string;
    userId?: string;
    postId: string;
    now: Date;
    expectedSupersededJobCount?: number;
  },
  validateXText: boolean,
): Promise<{ postId: string; revisionId: string; jobIds: string[]; supersededJobIds: string[] }> {
  const actor = persistedActor(input.actor, input.userId);
  await validateTargetOwnership(database, input, validateXText);
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

export function revisePostIntent(
  database: NodePgDatabase,
  input: Parameters<typeof revisePostIntentInternal>[1],
): ReturnType<typeof revisePostIntentInternal> {
  return revisePostIntentInternal(database, input, true);
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
  // Schedule-only changes copy an already-admitted revision. A later declaration
  // change must not retroactively reject its text, but ownership still applies.
  return revisePostIntentInternal(
    database,
    {
      ...input,
      content: revision.content as Record<string, unknown>,
      mediaIds: media.map((item) => item.id),
      providerAccountIds: jobs.map((job) => job.providerAccountId),
      expectedSupersededJobCount: jobs.length,
    },
    false,
  );
}
