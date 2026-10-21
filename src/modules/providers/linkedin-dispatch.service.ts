import { and, asc, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  postRevisions,
  mediaObjects,
  providerAccounts,
  providerConnections,
  publicationJobs,
  revisionMedia,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { getActiveCredential } from '../credentials/credential.repository.js';
import { decryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
import {
  claimDueJobs,
  deferLeasedJob,
  deriveJobIdempotencyKey,
  finishDispatchAttempt,
  recoverExpiredDispatches,
  startDispatchAttempt,
} from '../scheduler/job.repository.js';
import { calculateFullJitterDelay } from '../scheduler/retry-policy.js';
import {
  LinkedInRequestError,
  LinkedInVideoReadinessError,
  type LinkedInCredential,
  type LinkedInHttpClient,
} from './linkedin-http-client.js';
import {
  parseLinkedInContent,
  parseLinkedInImageContent,
  parseLinkedInVideoContent,
  validateLinkedInImageAsset,
  validateLinkedInVideoAsset,
} from './linkedin-content.js';
import { stageLinkedInImage } from './linkedin-image-staging.service.js';
import { PostgresLinkedInVideoArtifactStore } from './linkedin-video-artifact-store.js';
import { stageLinkedInVideo } from './linkedin-video-staging.service.js';
import type { XMediaSource } from './x-media-staging.service.js';

const credentialSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.iso.datetime(),
  memberUrn: z.string().regex(/^urn:li:person:[^\s]+$/),
  scope: z.string().min(1),
});
const LINKEDIN_RETRY_POLICY = { baseDelayMs: 30_000, maximumDelayMs: 900_000, maximumAttempts: 5 };
const LINKEDIN_VIDEO_POLL_MS = 30_000;

export function classifyLinkedInPrePostFailure(
  error: unknown,
  attemptNumber: number,
  now: Date,
  random: () => number = Math.random,
): { outcome: LinkedInRequestError['kind']; retryAt?: Date } {
  const request = error instanceof LinkedInRequestError ? error : null;
  const outcome = request?.kind ?? (error instanceof TypeError ? 'transient' : 'validation');
  if (outcome !== 'transient' && outcome !== 'rate_limit') return { outcome };
  const delay = calculateFullJitterDelay(attemptNumber, LINKEDIN_RETRY_POLICY, random);
  return {
    outcome,
    ...(delay === null ? {} : { retryAt: new Date(now.getTime() + delay) }),
  };
}

function requireStagedVideo(video: string | undefined): string {
  if (!video) throw new Error('LinkedIn video staging returned no asset');
  return video;
}

export function classifyLinkedInDispatchFailure(
  error: unknown,
  attemptNumber: number,
  now: Date,
  random: () => number = Math.random,
): { outcome: 'unknown' | LinkedInRequestError['kind']; retryAt?: Date } {
  if (error instanceof LinkedInVideoReadinessError) {
    if (error.permanent) return { outcome: 'validation' };
    const retryDelay = calculateFullJitterDelay(attemptNumber, LINKEDIN_RETRY_POLICY, random);
    return {
      outcome: 'transient',
      ...(retryDelay !== null ? { retryAt: new Date(now.getTime() + retryDelay) } : {}),
    };
  }
  const requestError = error instanceof LinkedInRequestError ? error : null;
  // A 429 rejects the request. A 5xx, transport error, or missing receipt may follow acceptance.
  if (!requestError || requestError.outcomeUnknown || requestError.kind === 'transient')
    return { outcome: 'unknown' };
  if (requestError.kind !== 'rate_limit') return { outcome: requestError.kind };
  const retryDelay = calculateFullJitterDelay(attemptNumber, LINKEDIN_RETRY_POLICY, random);
  return {
    outcome: 'rate_limit',
    ...(retryDelay !== null ? { retryAt: new Date(now.getTime() + retryDelay) } : {}),
  };
}

export interface LinkedInDispatchRuntime {
  database: NodePgDatabase;
  keys: MasterKeyProvider;
  client: LinkedInHttpClient;
  source: XMediaSource;
  workerId: string;
  leaseMs: number;
}

async function loadJob(runtime: LinkedInDispatchRuntime, workspaceId: string, jobId: string) {
  return withTenantTransaction(runtime.database, { workspaceId }, async (transaction) => {
    const rows = await transaction
      .select({
        content: postRevisions.content,
        providerAccountId: providerAccounts.providerAccountId,
        credentialId: providerConnections.credentialId,
        connectionId: providerConnections.id,
        expiresAt: providerConnections.expiresAt,
        status: providerConnections.status,
        mediaId: revisionMedia.mediaId,
        mimeType: mediaObjects.mimeType,
        byteSize: mediaObjects.byteSize,
        durationMs: mediaObjects.durationMs,
        container: mediaObjects.container,
        videoCodec: mediaObjects.videoCodec,
        audioCodec: mediaObjects.audioCodec,
        mediaState: mediaObjects.state,
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
      .leftJoin(
        revisionMedia,
        and(
          eq(revisionMedia.workspaceId, publicationJobs.workspaceId),
          eq(revisionMedia.revisionId, publicationJobs.revisionId),
        ),
      )
      .leftJoin(
        mediaObjects,
        and(
          eq(mediaObjects.workspaceId, revisionMedia.workspaceId),
          eq(mediaObjects.id, revisionMedia.mediaId),
          isNull(mediaObjects.deletedAt),
        ),
      )
      .where(
        and(
          eq(publicationJobs.workspaceId, workspaceId),
          eq(publicationJobs.id, jobId),
          eq(providerConnections.provider, 'linkedin'),
          isNull(providerAccounts.disconnectedAt),
        ),
      )
      .orderBy(asc(revisionMedia.position))
      .limit(2);
    const row = rows[0];
    if (!row) throw new Error('LinkedIn destination is unavailable');
    const mediaIds = rows.flatMap((item) => (item.mediaId ? [item.mediaId] : []));
    const content =
      (row.content as { kind?: unknown }).kind === 'video'
        ? parseLinkedInVideoContent(row.content, mediaIds)
        : (row.content as { kind?: unknown }).kind === 'single_image'
          ? parseLinkedInImageContent(row.content, mediaIds)
          : parseLinkedInContent(row.content, mediaIds);
    if (content.kind === 'link' && content.mediaId) {
      if (!row.mimeType || row.byteSize === null || row.mediaState !== 'ready')
        throw new Error('LinkedIn article thumbnail is unavailable');
      validateLinkedInImageAsset({ mimeType: row.mimeType, byteSize: row.byteSize });
    } else if (content.kind === 'video') {
      if (!row.mimeType || row.byteSize === null || row.mediaState !== 'ready')
        throw new Error('LinkedIn video media is unavailable');
      validateLinkedInVideoAsset({
        mimeType: row.mimeType,
        byteSize: row.byteSize,
        durationMs: row.durationMs,
        container: row.container,
        videoCodec: row.videoCodec,
        audioCodec: row.audioCodec,
      });
    } else if (content.kind === 'single_image') {
      if (!row.mimeType || row.byteSize === null || row.mediaState !== 'ready')
        throw new Error('LinkedIn image media is unavailable');
      validateLinkedInImageAsset({ mimeType: row.mimeType, byteSize: row.byteSize });
    }
    const stored = await getActiveCredential(transaction, workspaceId, row.credentialId);
    if (!stored) throw new Error('LinkedIn credential is unavailable');
    return { ...row, content, stored };
  });
}

async function markReconnectRequired(
  runtime: LinkedInDispatchRuntime,
  workspaceId: string,
  connectionId: string,
): Promise<void> {
  await withTenantTransaction(runtime.database, { workspaceId }, (transaction) =>
    transaction
      .update(providerConnections)
      .set({ status: 'reconnect_required', updatedAt: new Date() })
      .where(
        and(
          eq(providerConnections.workspaceId, workspaceId),
          eq(providerConnections.id, connectionId),
        ),
      ),
  );
}

async function dispatchJob(
  runtime: LinkedInDispatchRuntime,
  job: {
    id: string;
    workspaceId: string;
    revisionId: string;
    providerAccountId: string;
    attemptNumber: number;
  },
  now: Date,
): Promise<boolean> {
  let attempt: Awaited<ReturnType<typeof startDispatchAttempt>> = null;
  let connectionId: string | undefined;
  let isImageJob = false;
  try {
    const context = await loadJob(runtime, job.workspaceId, job.id);
    isImageJob =
      context.content.kind === 'single_image' ||
      (context.content.kind === 'link' && Boolean(context.content.mediaId));
    connectionId = context.connectionId;
    if (context.status !== 'active' || !context.expiresAt || context.expiresAt <= now) {
      await markReconnectRequired(runtime, job.workspaceId, context.connectionId);
      throw new LinkedInRequestError(401, 'auth', 'LinkedIn reconnect is required');
    }
    const plaintext = await decryptCredential(context.stored, runtime.keys);
    let credential: LinkedInCredential;
    try {
      credential = credentialSchema.parse(JSON.parse(plaintext.toString('utf8')));
    } finally {
      plaintext.fill(0);
    }
    if (
      credential.memberUrn !== context.providerAccountId ||
      Date.parse(credential.expiresAt) <= now.getTime()
    ) {
      await markReconnectRequired(runtime, job.workspaceId, context.connectionId);
      throw new LinkedInRequestError(401, 'auth', 'LinkedIn reconnect is required');
    }
    let video: string | undefined;
    let image: string | undefined;
    if (context.content.kind === 'video') {
      const artifact = new PostgresLinkedInVideoArtifactStore(runtime.database, {
        workspaceId: job.workspaceId,
        jobId: job.id,
        mediaId: context.content.mediaId,
        memberUrn: credential.memberUrn,
      });
      const staged = await stageLinkedInVideo({
        artifact,
        client: runtime.client,
        source: runtime.source,
        credential,
        workspaceId: job.workspaceId,
        mediaId: context.content.mediaId,
      });
      if (staged.state === 'pending') {
        await deferLeasedJob(runtime.database, {
          workspaceId: job.workspaceId,
          jobId: job.id,
          workerId: runtime.workerId,
          now,
          retryAt: new Date(now.getTime() + LINKEDIN_VIDEO_POLL_MS),
        });
        return false;
      }
      video = staged.video;
    } else if (
      context.content.kind === 'single_image' ||
      (context.content.kind === 'link' && context.content.mediaId)
    ) {
      const mediaId = context.content.mediaId;
      if (!mediaId) throw new Error('LinkedIn image media is unavailable');
      const artifact = new PostgresLinkedInVideoArtifactStore(runtime.database, {
        workspaceId: job.workspaceId,
        jobId: job.id,
        mediaId,
        memberUrn: credential.memberUrn,
        kind: 'image',
        now: () => now,
      });
      const staged = await stageLinkedInImage({
        artifact,
        client: runtime.client,
        source: runtime.source,
        credential,
        workspaceId: job.workspaceId,
        mediaId,
      });
      if (staged.state === 'pending') {
        await deferLeasedJob(runtime.database, {
          workspaceId: job.workspaceId,
          jobId: job.id,
          workerId: runtime.workerId,
          now,
          retryAt: new Date(now.getTime() + LINKEDIN_VIDEO_POLL_MS),
        });
        return false;
      }
      image = staged.image;
    }
    attempt = await startDispatchAttempt(runtime.database, {
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
    const externalPostId =
      context.content.kind === 'link'
        ? await runtime.client.publishArticle({
            credential,
            ...context.content,
            ...(image ? { thumbnail: image } : {}),
          })
        : context.content.kind === 'video'
          ? await runtime.client.publishVideo({
              credential,
              text: context.content.text,
              title: context.content.title,
              video: requireStagedVideo(video),
            })
          : context.content.kind === 'single_image'
            ? await runtime.client.publishImage({
                credential,
                text: context.content.text,
                image: requireStagedVideo(image),
              })
            : await runtime.client.publishText({ credential, text: context.content.text });
    await finishDispatchAttempt(runtime.database, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      attemptId: attempt.attemptId,
      outcome: 'published',
      externalPostId,
      externalUrl: `https://www.linkedin.com/feed/update/${encodeURIComponent(externalPostId)}/`,
      now,
    });
    return true;
  } catch (error) {
    const requestError = error instanceof LinkedInRequestError ? error : null;
    if (requestError?.kind === 'auth' && connectionId)
      await markReconnectRequired(runtime, job.workspaceId, connectionId);
    if (!attempt) {
      // Staging cannot have created a post. A lost lease is safely reclaimed;
      // otherwise record a definite pre-POST failure rather than reconciliation.
      attempt = await startDispatchAttempt(runtime.database, {
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
      const failure = classifyLinkedInPrePostFailure(error, job.attemptNumber, now);
      await finishDispatchAttempt(runtime.database, {
        workspaceId: job.workspaceId,
        jobId: job.id,
        attemptId: attempt.attemptId,
        outcome: failure.outcome,
        now,
        ...(failure.retryAt ? { retryAt: failure.retryAt } : {}),
        redactedError:
          requestError?.message ??
          (isImageJob ? 'LinkedIn image staging or readiness failed' : 'LinkedIn staging failed'),
      });
      return false;
    }
    const failure = classifyLinkedInDispatchFailure(error, attempt.attemptNumber, now);
    await finishDispatchAttempt(runtime.database, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      attemptId: attempt.attemptId,
      outcome: failure.outcome,
      now,
      ...(failure.retryAt ? { retryAt: failure.retryAt } : {}),
      ...(failure.outcome === 'unknown' ? { reconciliationKey: `linkedin:${job.id}` } : {}),
      redactedError:
        requestError?.message ??
        (error instanceof LinkedInVideoReadinessError
          ? error.message
          : 'LinkedIn dispatch outcome is unknown'),
    });
    return false;
  }
}

export async function dispatchDueLinkedInJobs(
  runtime: LinkedInDispatchRuntime,
  now = new Date(),
): Promise<number> {
  await recoverExpiredDispatches(runtime.database, now);
  const jobs = await claimDueJobs(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
    limit: 10,
    destinationProvider: 'linkedin',
  });
  let published = 0;
  for (const job of jobs) if (await dispatchJob(runtime, job, now)) published += 1;
  return published;
}
