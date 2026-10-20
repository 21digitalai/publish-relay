import { and, eq, sql } from 'drizzle-orm';

import { providerStagingArtifacts, publicationJobs } from '../../database/schema.js';
import {
  claimDueJobs,
  claimReconciliationJobs,
  deriveJobIdempotencyKey,
  finishDispatchAttempt,
  recoverExpiredDispatches,
  resolveReconciliation,
  startDispatchAttempt,
} from '../scheduler/job.repository.js';
import { getFreshSnapchatToken } from './snapchat-credential.service.js';
import { SnapchatSpotlightRequestError } from './snapchat-spotlight-client.js';
import { stageAndPostSnapchatSpotlight } from './snapchat-spotlight-upload.js';
import {
  loadSnapchatJob,
  recordSnapchatArtifact,
  reserveSnapchatArtifact,
  type SnapchatMediaRuntime,
} from './snapchat-dispatch-support.js';

export type SnapchatSpotlightRuntime = SnapchatMediaRuntime;

async function dispatchJob(
  runtime: SnapchatSpotlightRuntime,
  job: {
    id: string;
    workspaceId: string;
    revisionId: string;
    providerAccountId: string;
  },
  now: Date,
) {
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
  if (!attempt) return false;
  const publicationBoundary = { postMayHaveStarted: false };
  try {
    const context = await loadSnapchatJob(runtime, job.workspaceId, job.id);
    const token = await getFreshSnapchatToken(runtime.database, runtime.keys, runtime.oauthClient, {
      workspaceId: job.workspaceId,
      profileId: context.profileId,
      requestId: job.id,
      now,
    });
    if (!runtime.mediaStorage.openVerifiedRange)
      throw new Error('Snapchat requires verified streaming media storage');
    const openVerifiedRange = runtime.mediaStorage.openVerifiedRange.bind(runtime.mediaStorage);
    const artifactId = await reserveSnapchatArtifact(runtime, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      attemptNumber: attempt.attemptNumber,
      mediaId: context.mediaId,
      now,
    });
    const posted = await stageAndPostSnapchatSpotlight({
      client: runtime.client,
      workspaceId: job.workspaceId,
      profileId: context.profileId,
      accessToken: token.access_token,
      content: context.content,
      media: context,
      source: {
        open: async () => {
          const stream = await openVerifiedRange({
            storageKey: context.storageKey,
            sha256: context.sha256,
            byteSize: context.byteSize,
            start: 0,
            end: context.byteSize - 1,
          });
          if (!stream) throw new Error('Snapchat source media failed byte/hash verification');
          return stream;
        },
      },
      onMediaCreated: (id) =>
        recordSnapchatArtifact(runtime, job.workspaceId, artifactId, 'media', id),
      onBeforeSpotlightPost: () => {
        publicationBoundary.postMayHaveStarted = true;
        return Promise.resolve();
      },
      onSpotlightPosted: (id) =>
        recordSnapchatArtifact(runtime, job.workspaceId, artifactId, 'posted', id),
    });
    await finishDispatchAttempt(runtime.database, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      attemptId: attempt.attemptId,
      outcome: 'accepted_pending',
      externalPostId: posted.spotlightId,
      reconciliationKey: `snapchat:${posted.spotlightId}`,
      now,
    });
    return true;
  } catch (error) {
    const requestError = error instanceof SnapchatSpotlightRequestError ? error : null;
    const kind =
      requestError?.kind === 'unknown' && !publicationBoundary.postMayHaveStarted
        ? 'permanent'
        : (requestError?.kind ??
          (publicationBoundary.postMayHaveStarted ? 'unknown' : 'permanent'));
    await finishDispatchAttempt(runtime.database, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      attemptId: attempt.attemptId,
      outcome: kind,
      now,
      ...(kind === 'unknown' ? { reconciliationKey: `snapchat:${job.id}` } : {}),
      redactedError:
        kind === 'unknown'
          ? 'Snapchat publication outcome needs reconciliation'
          : 'Snapchat dispatch failed before publication acceptance',
    });
    return false;
  }
}

export async function dispatchDueSnapchatSpotlights(
  runtime: SnapchatSpotlightRuntime,
  now = new Date(),
): Promise<number> {
  await recoverExpiredDispatches(runtime.database, now);
  const jobs = await claimDueJobs(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
    limit: 10,
    destinationProvider: 'snapchat',
    contentKinds: ['spotlight_video'],
    requireMedia: true,
  });
  let accepted = 0;
  for (const job of jobs) if (await dispatchJob(runtime, job, now)) accepted += 1;
  return accepted;
}

export async function reconcileSnapchatSpotlights(
  runtime: SnapchatSpotlightRuntime,
  now = new Date(),
): Promise<number> {
  const jobIds = await claimReconciliationJobs(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
    limit: 10,
    destinationProvider: 'snapchat',
    contentKinds: ['spotlight_video'],
  });
  let resolved = 0;
  for (const jobId of jobIds) {
    try {
      const context = await runtime.database
        .select({
          workspaceId: publicationJobs.workspaceId,
          spotlightId: providerStagingArtifacts.externalObjectId,
        })
        .from(publicationJobs)
        .innerJoin(
          providerStagingArtifacts,
          and(
            eq(providerStagingArtifacts.workspaceId, publicationJobs.workspaceId),
            eq(providerStagingArtifacts.jobId, publicationJobs.id),
            eq(
              providerStagingArtifacts.artifactKey,
              sql`'snapchat:spotlight:' || ${publicationJobs.attemptNumber}::text`,
            ),
          ),
        )
        .where(eq(publicationJobs.id, jobId))
        .limit(1);
      const row = context[0];
      if (!row?.spotlightId) continue; // Ambiguous POST without an ID needs manual resolution.
      const job = await loadSnapchatJob(runtime, row.workspaceId, jobId);
      const token = await getFreshSnapchatToken(
        runtime.database,
        runtime.keys,
        runtime.oauthClient,
        { workspaceId: row.workspaceId, profileId: job.profileId, requestId: jobId, now },
      );
      const status = await runtime.client.lookup({
        profileId: job.profileId,
        spotlightId: row.spotlightId,
        accessToken: token.access_token,
      });
      const outcome =
        status === 'LIVE' ? 'published' : status === 'REJECTED' ? 'failed' : 'accepted_pending';
      if (
        await resolveReconciliation(runtime.database, {
          workspaceId: row.workspaceId,
          jobId,
          workerId: runtime.workerId,
          outcome,
          now,
          ...(outcome === 'published' ? { externalPostId: row.spotlightId } : {}),
        })
      )
        resolved += 1;
    } catch {
      /* Retain reconciliation lease for the next bounded retry. */
    }
  }
  return resolved;
}
