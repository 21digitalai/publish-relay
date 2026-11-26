import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { z } from 'zod';
import type { replacePostMediaSchema } from './post.contract.js';

import { auditEvents, publicationJobs, revisionMedia } from '../../database/schema.js';
import { allowAllActionPolicy, type ActionPolicy } from '../policy/action-policy.js';
import { PostRevisionConflictError, PostValidationError } from './post.errors.js';
import { lockUnstartedPost } from './post-revision-fence.js';
import { editPostInTransaction, type PostIntentInput } from './post.service.js';

/** Only explicit media-reference fields change; captions and provider strings remain byte-identical. */
function replaceReferences(value: unknown, mapping: Map<string, string>, key = ''): unknown {
  if (typeof value === 'string')
    return ['mediaId', 'mediaPreviewId', 'previewMediaId', 'mediaIds'].includes(key)
      ? (mapping.get(value) ?? value)
      : value;
  if (Array.isArray(value)) return value.map((item) => replaceReferences(item, mapping, key));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [name, replaceReferences(item, mapping, name)]),
  );
}

export async function replacePostMediaInTransaction(
  database: NodePgDatabase,
  input: z.infer<typeof replacePostMediaSchema> &
    Pick<
      PostIntentInput,
      'workspaceId' | 'userId' | 'actor' | 'requestId' | 'idempotencyKey' | 'enabledAdapters'
    > & { postId: string },
  policy: ActionPolicy = allowAllActionPolicy,
) {
  const { revision, jobs } = await lockUnstartedPost(database, input);
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
  const mapping = new Map(input.replacements.map((pair) => [pair.oldMediaId, pair.newMediaId]));
  if (
    mapping.size !== input.replacements.length ||
    input.replacements.some(
      (pair) =>
        pair.oldMediaId === pair.newMediaId || !media.some((item) => item.id === pair.oldMediaId),
    )
  )
    throw new PostRevisionConflictError('Old media mapping does not match current attachments');
  const mediaIds = media.map((item) => mapping.get(item.id) ?? item.id);
  if (new Set(mediaIds).size !== mediaIds.length)
    throw new PostValidationError('Replacement media must be unique');
  const firstJob = jobs[0];
  if (!firstJob) throw new PostRevisionConflictError('Post has no current targets');
  // Policy and canonical media ownership/provider validation still run in the normal revision service.
  const result = await editPostInTransaction(
    database,
    {
      ...input,
      content: replaceReferences(revision.content, mapping) as Record<string, unknown>,
      mediaIds,
      requireReadyMedia: true,
      providerAccountIds: jobs.map((job) => job.providerAccountId),
      scheduledAt: firstJob.scheduledAt,
      approvalRequired: firstJob.approvalRequired,
    },
    policy,
  );
  await preserveTargetState(database, { ...input, jobs, result, mapping });
  await database.insert(auditEvents).values({
    workspaceId: input.workspaceId,
    actorType: input.actor?.type === 'api-key' ? 'api_key' : (input.actor?.type ?? 'user'),
    actorId: input.actor?.id ?? input.userId,
    action: 'post.media.replace',
    targetType: 'post',
    targetId: input.postId,
    requestId: input.requestId ?? 'post.media.replace',
    metadata: {
      previousRevisionId: revision.id,
      revisionId: result.revisionId,
      replacements: input.replacements,
    },
  });
  return { postId: result.postId, revisionId: result.revisionId, jobIds: result.jobIds };
}

async function preserveTargetState(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    jobs: Awaited<ReturnType<typeof lockUnstartedPost>>['jobs'];
    result: { revisionId: string };
    mapping: Map<string, string>;
  },
) {
  const created = await database
    .select()
    .from(publicationJobs)
    .where(
      and(
        eq(publicationJobs.workspaceId, input.workspaceId),
        eq(publicationJobs.revisionId, input.result.revisionId),
      ),
    );
  for (const job of created) {
    const prior = input.jobs.find((old) => old.providerAccountId === job.providerAccountId);
    if (!prior) throw new PostRevisionConflictError('Target set changed');
    const payload = replaceReferences(prior.effectivePayload, input.mapping);
    // A changed admission contract must not silently rewrite a stored payload.
    if (!isDeepStrictEqual(payload, job.effectivePayload))
      throw new PostRevisionConflictError(
        'Provider payload changed beyond media; replacement refused',
      );
    await database
      .update(publicationJobs)
      .set({
        effectivePayload: payload,
        effectiveProviderSettings: prior.effectiveProviderSettings,
        scheduledAt: prior.scheduledAt,
        approvalRequired: prior.approvalRequired,
        approvedAt: prior.approvedAt,
        approvedByUserId: prior.approvedByUserId,
      })
      .where(
        and(eq(publicationJobs.workspaceId, input.workspaceId), eq(publicationJobs.id, job.id)),
      );
  }
}
