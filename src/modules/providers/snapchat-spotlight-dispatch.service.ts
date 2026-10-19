import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  mediaObjects,
  providerAccountExposures,
  providerAccounts,
  providerConnections,
  providerStagingArtifacts,
  publicationJobs,
  revisionMedia,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MediaStorage } from '../content/media-storage.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
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
import type { SnapchatHttpClient } from './snapchat-http-client.js';
import type { SnapchatSpotlightClient } from './snapchat-spotlight-client.js';
import { SnapchatSpotlightRequestError } from './snapchat-spotlight-client.js';
import {
  snapchatSpotlightContentSchema,
  validateSnapchatSpotlightMedia,
} from './snapchat-spotlight-content.js';
import { stageAndPostSnapchatSpotlight } from './snapchat-spotlight-upload.js';

const MEDIA_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface SnapchatSpotlightRuntime {
  database: NodePgDatabase;
  keys: MasterKeyProvider;
  oauthClient: SnapchatHttpClient;
  client: SnapchatSpotlightClient;
  mediaStorage: MediaStorage;
  workerId: string;
  leaseMs: number;
}

async function loadJob(runtime: SnapchatSpotlightRuntime, workspaceId: string, jobId: string) {
  return withTenantTransaction(runtime.database, { workspaceId }, async (tx) => {
    const rows = await tx
      .select({
        accountId: providerAccounts.id,
        profileId: providerAccounts.remoteAccountId,
        connectionProfileId: providerConnections.externalSubjectId,
        mediaId: mediaObjects.id,
        mimeType: mediaObjects.mimeType,
        byteSize: mediaObjects.byteSize,
        durationMs: mediaObjects.durationMs,
        width: mediaObjects.width,
        height: mediaObjects.height,
        storageKey: mediaObjects.storageKey,
        sha256: mediaObjects.sha256,
        content: publicationJobs.effectivePayload,
      })
      .from(publicationJobs)
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
          eq(providerConnections.workspaceId, providerAccounts.workspaceId),
          eq(providerConnections.id, providerAccounts.connectionId),
        ),
      )
      .innerJoin(
        providerAccountExposures,
        and(
          eq(providerAccountExposures.workspaceId, publicationJobs.workspaceId),
          eq(providerAccountExposures.providerAccountId, providerAccounts.id),
          isNull(providerAccountExposures.revokedAt),
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
          eq(providerAccounts.destinationProvider, 'snapchat'),
          eq(providerAccounts.availability, 'active'),
          isNull(providerAccounts.disconnectedAt),
          eq(providerConnections.provider, 'snapchat'),
          eq(providerConnections.status, 'active'),
          isNull(providerConnections.revokedAt),
          eq(mediaObjects.state, 'ready'),
          isNull(mediaObjects.deletedAt),
        ),
      )
      .limit(2);
    const row = rows[0];
    if (rows.length !== 1 || !row || row.profileId !== row.connectionProfileId)
      throw new Error('Snapchat owner profile or media is unavailable');
    const content = snapchatSpotlightContentSchema.parse(row.content);
    if (content.mediaId !== row.mediaId) throw new Error('Snapchat job media changed');
    validateSnapchatSpotlightMedia(row);
    return { ...row, content };
  });
}

async function reserveArtifact(
  runtime: SnapchatSpotlightRuntime,
  input: {
    workspaceId: string;
    jobId: string;
    attemptNumber: number;
    mediaId: string;
    now: Date;
  },
) {
  return withTenantTransaction(runtime.database, input, async (tx) => {
    if (input.attemptNumber > 1)
      await tx
        .update(providerStagingArtifacts)
        .set({ deletedAt: input.now, updatedAt: input.now })
        .where(
          and(
            eq(providerStagingArtifacts.workspaceId, input.workspaceId),
            eq(providerStagingArtifacts.jobId, input.jobId),
            eq(providerStagingArtifacts.mediaId, input.mediaId),
            eq(
              providerStagingArtifacts.artifactKey,
              `snapchat:spotlight:${String(input.attemptNumber - 1)}`,
            ),
            isNull(providerStagingArtifacts.deletedAt),
            isNull(providerStagingArtifacts.externalObjectId),
            sql`EXISTS (SELECT 1 FROM publication_attempts attempt
              WHERE attempt.workspace_id = ${input.workspaceId}
                AND attempt.job_id = ${input.jobId}
                AND attempt.attempt_number = ${input.attemptNumber - 1}
                AND attempt.outcome = 'permanent'
                AND attempt.reconciliation_key IS NULL)`,
          ),
        );
    const rows = await tx
      .insert(providerStagingArtifacts)
      .values({
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        mediaId: input.mediaId,
        artifactKey: `snapchat:spotlight:${String(input.attemptNumber)}`,
        artifactKind: 'snapchat_spotlight',
        providerReference: 'snapchat:spotlight',
        expiresAt: new Date(input.now.getTime() + MEDIA_LIFETIME_MS),
      })
      .onConflictDoNothing()
      .returning({ id: providerStagingArtifacts.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('Snapchat staging already exists; reconcile before retry');
    return id;
  });
}

async function recordArtifact(
  runtime: SnapchatSpotlightRuntime,
  workspaceId: string,
  artifactId: string,
  status: 'media' | 'posted',
  externalId: string,
) {
  await withTenantTransaction(runtime.database, { workspaceId }, async (tx) => {
    const rows = await tx
      .update(providerStagingArtifacts)
      .set({
        artifactStatus: status,
        externalObjectId: status === 'posted' ? externalId : null,
        ...(status === 'media' ? { redactedEvidence: { mediaId: externalId } } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(providerStagingArtifacts.workspaceId, workspaceId),
          eq(providerStagingArtifacts.id, artifactId),
        ),
      )
      .returning({ id: providerStagingArtifacts.id });
    if (!rows[0]) throw new Error('Snapchat staging artifact disappeared');
  });
}

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
    const context = await loadJob(runtime, job.workspaceId, job.id);
    const token = await getFreshSnapchatToken(runtime.database, runtime.keys, runtime.oauthClient, {
      workspaceId: job.workspaceId,
      profileId: context.profileId,
      requestId: job.id,
      now,
    });
    if (!runtime.mediaStorage.openVerifiedRange)
      throw new Error('Snapchat requires verified streaming media storage');
    const openVerifiedRange = runtime.mediaStorage.openVerifiedRange.bind(runtime.mediaStorage);
    const artifactId = await reserveArtifact(runtime, {
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
      onMediaCreated: (id) => recordArtifact(runtime, job.workspaceId, artifactId, 'media', id),
      onBeforeSpotlightPost: () => {
        publicationBoundary.postMayHaveStarted = true;
        return Promise.resolve();
      },
      onSpotlightPosted: (id) => recordArtifact(runtime, job.workspaceId, artifactId, 'posted', id),
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
      const job = await loadJob(runtime, row.workspaceId, jobId);
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
