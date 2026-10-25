import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { MediaStorage } from '../content/media-storage.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import {
  claimDueJobs,
  deferLeasedJob,
  deriveJobIdempotencyKey,
  finishDispatchAttempt,
  recoverExpiredDispatches,
  startDispatchAttempt,
  type ClaimedJob,
} from '../scheduler/job.repository.js';
import { calculateFullJitterDelay } from '../scheduler/retry-policy.js';
import {
  getFinalizedFanvueMediaUuids,
  getFanvueStagingProgress,
} from './fanvue-artifact.repository.js';
import {
  FanvueReconnectionRequiredError,
  getFreshFanvueToken,
} from './fanvue-credential.service.js';
import {
  assertFanvueDispatchPreflight,
  loadFanvueDispatchContext,
} from './fanvue-dispatch-context.repository.js';
import { FanvueRequestError, type FanvueHttpClient } from './fanvue-http-client.js';
import type { FanvueMediaUploadClient } from './fanvue-media-upload-client.js';
import { buildFanvuePostPayload } from './fanvue-post-payload.js';
import { FanvuePostOutcomeUnknownError, type FanvuePostClient } from './fanvue-post-client.js';
import {
  FanvueStagingPendingError,
  stageFanvueJobMedia,
} from './fanvue-stage-job-media.service.js';

const RETRY_POLICY = { baseDelayMs: 30_000, maximumDelayMs: 900_000, maximumAttempts: 5 };
const STAGING_RECHECK_MS = 60_000;

export interface FanvuePostDispatchRuntime {
  database: NodePgDatabase;
  keys: MasterKeyProvider;
  storage: MediaStorage;
  oauthClient: FanvueHttpClient;
  mediaClient: FanvueMediaUploadClient;
  postClient: FanvuePostClient;
  workerId: string;
  leaseMs: number;
}

export function classifyFanvuePostFailure(
  error: unknown,
  attemptNumber: number,
  now: Date,
  random: () => number = Math.random,
): { outcome: 'unknown' | 'validation' | 'auth' | 'rate_limit'; retryAt?: Date } {
  if (error instanceof FanvuePostOutcomeUnknownError) return { outcome: 'unknown' as const };
  if (!(error instanceof FanvueRequestError)) return { outcome: 'unknown' as const };
  if (error.status === 400) return { outcome: 'validation' as const };
  if (error.status === 401 || error.status === 403) return { outcome: 'auth' as const };
  if (error.status !== 429) return { outcome: 'unknown' as const };
  const delay = calculateFullJitterDelay(attemptNumber, RETRY_POLICY, random);
  return {
    outcome: 'rate_limit' as const,
    ...(delay === null ? {} : { retryAt: new Date(now.getTime() + delay) }),
  };
}

async function dispatchClaimedFanvueJob(
  runtime: FanvuePostDispatchRuntime,
  job: ClaimedJob,
  now: Date,
): Promise<boolean> {
  const identity = { workspaceId: job.workspaceId, jobId: job.id, leaseOwner: runtime.workerId };
  let attempt: Awaited<ReturnType<typeof startDispatchAttempt>> = null;
  let currentMediaId: string | null = null;
  try {
    const context = await loadFanvueDispatchContext(runtime.database, identity);
    const token = await getFreshFanvueToken(runtime.database, runtime.keys, runtime.oauthClient, {
      workspaceId: job.workspaceId,
      creatorId: context.creatorId,
      now,
    });
    for (const mediaId of context.content.mediaIds) {
      currentMediaId = mediaId;
      const state = await stageFanvueJobMedia(
        runtime.database,
        runtime.storage,
        runtime.mediaClient,
        runtime.keys,
        { ...identity, mediaId, accessToken: token.access_token },
      );
      if (state === 'processing') {
        const deferredAt = new Date();
        await deferLeasedJob(runtime.database, {
          workspaceId: job.workspaceId,
          jobId: job.id,
          workerId: runtime.workerId,
          now: deferredAt,
          retryAt: new Date(deferredAt.getTime() + STAGING_RECHECK_MS),
        });
        return false;
      }
    }
    const media = await getFinalizedFanvueMediaUuids(runtime.database, identity);
    const payload = buildFanvuePostPayload(context.content, media);
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
      preflight: (transaction) =>
        assertFanvueDispatchPreflight(transaction, {
          workspaceId: job.workspaceId,
          jobId: job.id,
          creatorId: context.creatorId,
          mediaIds: context.content.mediaIds,
          readyMedia: media,
        }),
    });
    if (!attempt) return false;
    const created = await runtime.postClient.createPost(token.access_token, payload);
    const finished = await finishDispatchAttempt(runtime.database, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      attemptId: attempt.attemptId,
      outcome: 'published',
      externalPostId: created.uuid,
      now: new Date(),
    });
    if (!finished) throw new FanvuePostOutcomeUnknownError();
    return true;
  } catch (error) {
    if (!attempt && currentMediaId) {
      let phase: string | undefined;
      if (error instanceof FanvueStagingPendingError) phase = error.phase;
      else {
        try {
          phase = (
            await getFanvueStagingProgress(runtime.database, runtime.keys, {
              ...identity,
              mediaId: currentMediaId,
            })
          )?.phase;
        } catch {
          phase = undefined;
        }
      }
      if (phase === 'session_pending' || phase === 'put_pending' || phase === 'complete_pending') {
        attempt = await startDispatchAttempt(runtime.database, {
          workspaceId: job.workspaceId,
          jobId: job.id,
          workerId: runtime.workerId,
          fingerprint: deriveJobIdempotencyKey({
            jobId: job.id,
            revisionId: job.revisionId,
            providerAccountId: job.providerAccountId,
          }),
          now: new Date(),
        });
        if (!attempt) return false;
        await finishDispatchAttempt(runtime.database, {
          workspaceId: job.workspaceId,
          jobId: job.id,
          attemptId: attempt.attemptId,
          outcome: 'unknown',
          reconciliationKey: `fanvue-stage:${job.id}:${currentMediaId}`,
          redactedError: `Fanvue media staging ${phase} requires reconciliation; post not sent`,
          now: new Date(),
        });
        return false;
      }
    }
    if (!attempt) {
      // No post call was made. Record a definite failure only if this lease still owns the job.
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
      await finishDispatchAttempt(runtime.database, {
        workspaceId: job.workspaceId,
        jobId: job.id,
        attemptId: attempt.attemptId,
        outcome: error instanceof FanvueReconnectionRequiredError ? 'auth' : 'validation',
        redactedError:
          error instanceof FanvueReconnectionRequiredError
            ? 'Fanvue account requires reconnection before post'
            : 'Fanvue pre-post validation or staging failed',
        now: new Date(),
      });
      return false;
    }
    const failure = classifyFanvuePostFailure(error, attempt.attemptNumber, new Date());
    await finishDispatchAttempt(runtime.database, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      attemptId: attempt.attemptId,
      outcome: failure.outcome,
      ...(failure.retryAt ? { retryAt: failure.retryAt } : {}),
      ...(failure.outcome === 'unknown' ? { reconciliationKey: `fanvue:${job.id}` } : {}),
      redactedError: `Fanvue post ${failure.outcome}`,
      now: new Date(),
    });
    return false;
  }
}

export async function dispatchDueFanvueJobs(
  runtime: FanvuePostDispatchRuntime,
  now = new Date(),
): Promise<number> {
  await recoverExpiredDispatches(runtime.database, now);
  const jobs = await claimDueJobs(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
    limit: 10,
    destinationProvider: 'fanvue',
    contentKinds: ['post'],
  });
  let published = 0;
  for (const job of jobs) if (await dispatchClaimedFanvueJob(runtime, job, now)) published += 1;
  return published;
}
