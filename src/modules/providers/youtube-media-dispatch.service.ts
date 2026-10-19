import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  mediaObjects,
  postRevisions,
  providerAccounts,
  providerConnections,
  publicationJobs,
  revisionMedia,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  claimDueJobs,
  claimReconciliationJobs,
  deriveJobIdempotencyKey,
  finishDispatchAttempt,
  recoverExpiredDispatches,
  resolveReconciliation,
  startDispatchAttempt,
} from '../scheduler/job.repository.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import { getFreshYouTubeCredential } from './youtube-credential.service.js';
import { YouTubeRequestError, type YouTubeHttpClient } from './youtube-http-client.js';
import { stageYouTubeMedia, type YouTubeMediaSource } from './youtube-media-staging.service.js';

const settingsSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().min(1).max(100),
  description: z.string().max(5_000).optional(),
  privacyStatus: z.enum(['public', 'unlisted', 'private']),
  madeForKids: z.boolean(),
  notifySubscribers: z.boolean(),
  tags: z.array(z.string().min(1)).optional(),
  categoryId: z.string().min(1).optional(),
});

export interface YouTubeDispatchRuntime {
  database: NodePgDatabase;
  keys: MasterKeyProvider;
  source: YouTubeMediaSource;
  client: YouTubeHttpClient;
  workerId: string;
  leaseMs: number;
}

async function loadJobContext(database: NodePgDatabase, workspaceId: string, jobId: string) {
  return withTenantTransaction(database, { workspaceId }, async (transaction) => {
    const rows = await transaction
      .select({
        credentialId: providerConnections.credentialId,
        mediaId: revisionMedia.mediaId,
        mimeType: mediaObjects.mimeType,
        settings: publicationJobs.effectiveProviderSettings,
      })
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
      .innerJoin(
        providerConnections,
        and(
          eq(providerConnections.workspaceId, publicationJobs.workspaceId),
          eq(providerConnections.id, providerAccounts.connectionId),
        ),
      )
      .innerJoin(
        revisionMedia,
        and(
          eq(revisionMedia.workspaceId, publicationJobs.workspaceId),
          eq(revisionMedia.revisionId, publicationJobs.revisionId),
        ),
      )
      .innerJoin(
        mediaObjects,
        and(
          eq(mediaObjects.workspaceId, revisionMedia.workspaceId),
          eq(mediaObjects.id, revisionMedia.mediaId),
        ),
      )
      .where(
        and(
          eq(publicationJobs.workspaceId, workspaceId),
          eq(publicationJobs.id, jobId),
          eq(providerAccounts.destinationProvider, 'youtube'),
        ),
      )
      .limit(2);
    if (rows.length !== 1 || rows[0]?.mimeType !== 'video/mp4')
      throw new Error('YouTube job requires exactly one MP4 video');
    return { ...rows[0], settings: settingsSchema.parse(rows[0].settings) };
  });
}

function uploadMetadata(settings: z.infer<typeof settingsSchema>): Record<string, unknown> {
  return {
    snippet: {
      title: settings.title,
      ...(settings.description === undefined ? {} : { description: settings.description }),
      ...(settings.tags === undefined ? {} : { tags: settings.tags }),
      ...(settings.categoryId === undefined ? {} : { categoryId: settings.categoryId }),
    },
    status: {
      privacyStatus: settings.privacyStatus,
      selfDeclaredMadeForKids: settings.madeForKids,
    },
  };
}

async function uploadClaimedJob(
  runtime: YouTubeDispatchRuntime,
  job: { id: string; workspaceId: string; revisionId: string; providerAccountId: string },
  now: Date,
): Promise<'published' | 'unresolved'> {
  const context = await loadJobContext(runtime.database, job.workspaceId, job.id);
  const attempt = await startDispatchAttempt(runtime.database, {
    workspaceId: job.workspaceId,
    jobId: job.id,
    workerId: runtime.workerId,
    fingerprint: deriveJobIdempotencyKey({
      jobId: job.id,
      revisionId: job.revisionId,
      providerAccountId: job.providerAccountId,
    }),
    now,
  });
  if (!attempt) return 'unresolved';
  try {
    const credential = await getFreshYouTubeCredential(
      runtime.database,
      runtime.keys,
      runtime.client,
      {
        workspaceId: job.workspaceId,
        credentialId: context.credentialId,
        now,
      },
    );
    const uploaded = await stageYouTubeMedia(
      runtime.database,
      runtime.source,
      runtime.client,
      runtime.keys,
      {
        workspaceId: job.workspaceId,
        jobId: job.id,
        mediaId: context.mediaId,
        accessToken: credential.accessToken,
        metadata: uploadMetadata(context.settings),
        notifySubscribers: context.settings.notifySubscribers,
        now,
      },
    );
    await finishDispatchAttempt(runtime.database, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      attemptId: attempt.attemptId,
      outcome: 'published',
      externalPostId: uploaded.videoId,
      externalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(uploaded.videoId)}`,
      now,
    });
    return 'published';
  } catch (error) {
    const providerError = error instanceof YouTubeRequestError ? error : null;
    const retryable = providerError?.kind === 'quota' || providerError?.kind === 'transient';
    const retryAt = retryable
      ? new Date(now.getTime() + (providerError.retryAfterSeconds ?? 30) * 1_000)
      : undefined;
    await finishDispatchAttempt(runtime.database, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      attemptId: attempt.attemptId,
      outcome: providerError?.outcomeUnknown
        ? 'unknown'
        : providerError?.kind === 'quota'
          ? 'rate_limit'
          : (providerError?.kind ?? 'permanent'),
      now,
      ...(retryAt ? { retryAt } : {}),
      ...(providerError?.outcomeUnknown ? { reconciliationKey: `youtube:${job.id}` } : {}),
      redactedError: providerError?.message ?? 'YouTube dispatch failed',
    });
    return 'unresolved';
  }
}

export async function dispatchDueYouTubeJobs(
  runtime: YouTubeDispatchRuntime,
  now = new Date(),
): Promise<number> {
  const jobs = await claimDueJobs(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
    limit: 10,
    destinationProvider: 'youtube',
    requireMedia: true,
  });
  let published = 0;
  for (const job of jobs)
    if ((await uploadClaimedJob(runtime, job, now)) === 'published') published += 1;
  return published;
}

export async function reconcileYouTubeJobs(
  runtime: YouTubeDispatchRuntime,
  now = new Date(),
): Promise<number> {
  await recoverExpiredDispatches(runtime.database, now);
  const jobIds = await claimReconciliationJobs(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
    limit: 10,
    destinationProvider: 'youtube',
  });
  let resolved = 0;
  for (const jobId of jobIds) {
    try {
      const rows = await runtime.database
        .select({
          id: publicationJobs.id,
          workspaceId: publicationJobs.workspaceId,
          revisionId: publicationJobs.revisionId,
          providerAccountId: publicationJobs.providerAccountId,
        })
        .from(publicationJobs)
        .where(eq(publicationJobs.id, jobId))
        .limit(1);
      const job = rows[0];
      if (!job) continue;
      const context = await loadJobContext(runtime.database, job.workspaceId, job.id);
      const credential = await getFreshYouTubeCredential(
        runtime.database,
        runtime.keys,
        runtime.client,
        {
          workspaceId: job.workspaceId,
          credentialId: context.credentialId,
          now,
        },
      );
      const uploaded = await stageYouTubeMedia(
        runtime.database,
        runtime.source,
        runtime.client,
        runtime.keys,
        {
          workspaceId: job.workspaceId,
          jobId: job.id,
          mediaId: context.mediaId,
          accessToken: credential.accessToken,
          metadata: uploadMetadata(context.settings),
          notifySubscribers: context.settings.notifySubscribers,
          now,
        },
      );
      if (
        await resolveReconciliation(runtime.database, {
          workspaceId: job.workspaceId,
          jobId: job.id,
          workerId: runtime.workerId,
          outcome: 'published',
          externalPostId: uploaded.videoId,
          externalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(uploaded.videoId)}`,
          now,
        })
      )
        resolved += 1;
    } catch {
      // Keep reconciliation authority intact for a later lease while allowing other jobs to proceed.
    }
  }
  return resolved;
}
