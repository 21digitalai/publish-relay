import type { SnapchatStoryClient } from './snapchat-story-client.js';
import { SnapchatSpotlightRequestError } from './snapchat-spotlight-client.js';
import {
  loadSnapchatJob,
  recordSnapchatArtifact,
  reserveSnapchatArtifact,
  type SnapchatMediaRuntime,
} from './snapchat-dispatch-support.js';
import { getFreshSnapchatToken } from './snapchat-credential.service.js';
import { stageAndPostSnapchatStory } from './snapchat-story-upload.js';
import {
  claimDueJobs,
  deriveJobIdempotencyKey,
  finishDispatchAttempt,
  recoverExpiredDispatches,
  startDispatchAttempt,
} from '../scheduler/job.repository.js';

const PRE_POST_RETRY_MS = 60_000;

export interface SnapchatStoryRuntime extends SnapchatMediaRuntime {
  client: SnapchatStoryClient;
}

async function dispatchStory(
  runtime: SnapchatStoryRuntime,
  job: { id: string; workspaceId: string; revisionId: string; providerAccountId: string },
  now: Date,
): Promise<boolean> {
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
  const publication = { mayHaveStarted: false, requestId: null as string | null };
  try {
    const context = await loadSnapchatJob(runtime, job.workspaceId, job.id, 'story');
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
      kind: 'story',
    });
    const posted = await stageAndPostSnapchatStory({
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
      onBeforeStoryPost: () => {
        publication.mayHaveStarted = true;
        return Promise.resolve();
      },
      onStoryPosted: async (id) => {
        publication.requestId = id;
        await recordSnapchatArtifact(runtime, job.workspaceId, artifactId, 'posted', id);
      },
    });
    publication.requestId = posted.requestId;
    // Snap returns a request correlation ID, not a Story ID or publication proof.
    await finishDispatchAttempt(runtime.database, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      attemptId: attempt.attemptId,
      outcome: 'unknown',
      providerRequestId: publication.requestId,
      reconciliationKey: `snapchat:story:${job.id}`,
      redactedError: 'Snapchat Story outcome needs manual verification',
      now,
    });
    return true;
  } catch (error) {
    const requestError = error instanceof SnapchatSpotlightRequestError ? error : null;
    const kind = publication.mayHaveStarted
      ? 'unknown'
      : requestError?.kind === 'rate_limit' || requestError?.kind === 'transient'
        ? 'transient'
        : 'permanent';
    await finishDispatchAttempt(runtime.database, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      attemptId: attempt.attemptId,
      outcome: kind,
      ...(kind === 'transient' ? { retryAt: new Date(now.getTime() + PRE_POST_RETRY_MS) } : {}),
      ...(kind === 'unknown' ? { reconciliationKey: `snapchat:story:${job.id}` } : {}),
      ...(kind === 'unknown' && publication.requestId
        ? { providerRequestId: publication.requestId }
        : {}),
      redactedError:
        kind === 'unknown'
          ? 'Snapchat Story outcome needs manual verification'
          : 'Snapchat Story failed before the publication request',
      now,
    });
    return false;
  }
}

// Fixture-only: no production worker registration or generic Story admission.
export async function dispatchDueSnapchatStories(
  runtime: SnapchatStoryRuntime,
  now = new Date(),
): Promise<number> {
  await recoverExpiredDispatches(runtime.database, now);
  const jobs = await claimDueJobs(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
    limit: 10,
    destinationProvider: 'snapchat',
    contentKinds: ['story_image', 'story_video'],
    requireMedia: true,
  });
  let sent = 0;
  for (const job of jobs) if (await dispatchStory(runtime, job, now)) sent += 1;
  return sent;
}
