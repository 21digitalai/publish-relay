import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  mediaObjects,
  providerAccounts,
  publicationJobs,
  revisionMedia,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { getActiveCredential } from '../credentials/credential.repository.js';
import { decryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
import {
  claimDueJobs,
  claimReconciliationJobs,
  deriveJobIdempotencyKey,
  finishDispatchAttempt,
  recoverExpiredDispatches,
  resolveReconciliation,
  startDispatchAttempt,
} from '../scheduler/job.repository.js';
import { FacebookPublishingAdapter } from './facebook-adapter.js';
import { PostgresFacebookArtifactStore } from './facebook-artifact-store.js';
import type { FacebookHttpClient } from './facebook-http-client.js';
import type { InstagramMediaTokenCodec } from './instagram-media-token.js';
import type { PublishContent } from './contract.js';

const linkPayloadSchema = z.object({
  kind: z.literal('link'),
  message: z.string(),
  linkUrl: z.url().refine((value) => new URL(value).protocol === 'https:'),
});
const imagePayloadSchema = z.object({
  kind: z.literal('single_image'),
  message: z.string(),
  mediaIds: z.array(z.string()).length(1),
});

export interface FacebookDispatchRuntime {
  database: NodePgDatabase;
  keys: MasterKeyProvider;
  client: FacebookHttpClient;
  tokenCodec: InstagramMediaTokenCodec;
  publicOrigin: string;
  workerId: string;
  leaseMs: number;
}

interface FacebookJob {
  id: string;
  workspaceId: string;
  revisionId: string;
  providerAccountId: string;
}

export function getFacebookRetryAt(
  outcome: { status: string; code?: string; retryAfterSeconds?: number },
  now: Date,
): Date | undefined {
  if (outcome.status !== 'failed' || !['rate_limit', 'transient'].includes(outcome.code ?? ''))
    return undefined;
  const seconds = Math.min(300, Math.max(1, outcome.retryAfterSeconds ?? 5));
  return new Date(now.getTime() + seconds * 1000);
}

async function loadContext(database: NodePgDatabase, workspaceId: string, jobId: string) {
  return withTenantTransaction(database, { workspaceId }, async (tx) => {
    const [base] = await tx
      .select({
        accountRemoteId: providerAccounts.remoteAccountId,
        availability: providerAccounts.availability,
        credentialId: providerAccounts.credentialId,
        effectivePayload: publicationJobs.effectivePayload,
      })
      .from(publicationJobs)
      .innerJoin(
        providerAccounts,
        and(
          eq(providerAccounts.workspaceId, publicationJobs.workspaceId),
          eq(providerAccounts.id, publicationJobs.providerAccountId),
        ),
      )
      .where(
        and(
          eq(publicationJobs.workspaceId, workspaceId),
          eq(publicationJobs.id, jobId),
          eq(providerAccounts.destinationProvider, 'facebook_page'),
        ),
      )
      .limit(1);
    if (!base?.credentialId || base.availability !== 'active')
      throw new Error('Facebook Page destination is unavailable');
    const credentialId = base.credentialId;
    const payload = z.union([linkPayloadSchema, imagePayloadSchema]).parse(base.effectivePayload);
    if (payload.kind === 'link') return { ...base, credentialId, payload, media: [] };
    const media = await tx
      .select({ id: mediaObjects.id, mimeType: mediaObjects.mimeType })
      .from(revisionMedia)
      .innerJoin(
        mediaObjects,
        and(
          eq(mediaObjects.workspaceId, revisionMedia.workspaceId),
          eq(mediaObjects.id, revisionMedia.mediaId),
        ),
      )
      .innerJoin(
        publicationJobs,
        and(
          eq(publicationJobs.workspaceId, revisionMedia.workspaceId),
          eq(publicationJobs.revisionId, revisionMedia.revisionId),
        ),
      )
      .where(and(eq(publicationJobs.workspaceId, workspaceId), eq(publicationJobs.id, jobId)))
      .orderBy(asc(revisionMedia.position));
    if (media.length !== 1 || media[0]?.id !== payload.mediaIds[0])
      throw new Error('Facebook effective image payload does not match revision media');
    return { ...base, credentialId, payload, media };
  });
}

async function readToken(
  runtime: FacebookDispatchRuntime,
  workspaceId: string,
  credentialId: string,
) {
  const stored = await withTenantTransaction(runtime.database, { workspaceId }, (tx) =>
    getActiveCredential(tx, workspaceId, credentialId),
  );
  if (!stored) throw new Error('Meta credential is unavailable');
  const plaintext = await decryptCredential(stored, runtime.keys);
  try {
    const value = JSON.parse(plaintext.toString('utf8')) as { accessToken?: unknown };
    if (typeof value.accessToken !== 'string' || !value.accessToken)
      throw new Error('Invalid Meta credential');
    return value.accessToken;
  } finally {
    plaintext.fill(0);
  }
}

async function markUnavailable(
  runtime: FacebookDispatchRuntime,
  workspaceId: string,
  accountId: string,
  reason: 'reauth_required' | 'permission_lost',
) {
  await withTenantTransaction(runtime.database, { workspaceId }, (tx) =>
    tx
      .update(providerAccounts)
      .set({ availability: reason, updatedAt: new Date() })
      .where(
        and(eq(providerAccounts.workspaceId, workspaceId), eq(providerAccounts.id, accountId)),
      ),
  );
}

async function createAdapter(
  runtime: FacebookDispatchRuntime,
  job: FacebookJob,
  credentialId: string,
  now: Date,
) {
  const accessToken = await readToken(runtime, job.workspaceId, credentialId);
  return new FacebookPublishingAdapter({
    client: runtime.client,
    artifacts: new PostgresFacebookArtifactStore(runtime.database, {
      workspaceId: job.workspaceId,
      jobId: job.id,
    }),
    accessToken: () => Promise.resolve(accessToken),
    mediaUrl: (mediaId) => {
      const token = runtime.tokenCodec.issue({
        workspaceId: job.workspaceId,
        mediaId,
        expiresAt: now.getTime() + 24 * 60 * 60 * 1000,
      });
      const url = new URL('/provider-media/instagram', runtime.publicOrigin);
      url.searchParams.set('token', token);
      return Promise.resolve(url.toString());
    },
  });
}

function publishContent(context: Awaited<ReturnType<typeof loadContext>>): PublishContent {
  return context.payload.kind === 'link'
    ? {
        kind: 'link',
        text: context.payload.message,
        url: context.payload.linkUrl,
        media: [],
      }
    : { kind: 'text', text: context.payload.message, media: context.media };
}

async function failPreflight(
  runtime: FacebookDispatchRuntime,
  job: FacebookJob,
  attemptId: string,
  now: Date,
  redactedError: string,
) {
  await finishDispatchAttempt(runtime.database, {
    workspaceId: job.workspaceId,
    jobId: job.id,
    attemptId,
    outcome: 'permanent',
    now,
    redactedError,
  });
}

async function dispatchJob(
  runtime: FacebookDispatchRuntime,
  job: FacebookJob,
  now: Date,
) {
  const fingerprint = deriveJobIdempotencyKey({
    jobId: job.id,
    revisionId: job.revisionId,
    providerAccountId: job.providerAccountId,
  });
  const attempt = await startDispatchAttempt(runtime.database, {
    workspaceId: job.workspaceId,
    jobId: job.id,
    workerId: runtime.workerId,
    fingerprint,
    now,
  });
  if (!attempt) return false;
  let context: Awaited<ReturnType<typeof loadContext>>;
  try {
    context = await loadContext(runtime.database, job.workspaceId, job.id);
  } catch {
    await failPreflight(
      runtime,
      job,
      attempt.attemptId,
      now,
      'Facebook Page destination is unavailable',
    );
    return false;
  }
  let adapter: FacebookPublishingAdapter;
  try {
    adapter = await createAdapter(runtime, job, context.credentialId, now);
  } catch {
    await failPreflight(
      runtime,
      job,
      attempt.attemptId,
      now,
      'Facebook credential is unavailable',
    );
    return false;
  }
  const outcome = await adapter.publish(
    await adapter.stage(context.accountRemoteId, publishContent(context), fingerprint),
  );
  const retryAt = getFacebookRetryAt(outcome, now);
  if (outcome.status === 'failed' && outcome.code === 'auth')
    await markUnavailable(
      runtime,
      job.workspaceId,
      job.providerAccountId,
      outcome.message.includes('(permission,') ? 'permission_lost' : 'reauth_required',
    );
  await finishDispatchAttempt(runtime.database, {
    workspaceId: job.workspaceId,
    jobId: job.id,
    attemptId: attempt.attemptId,
    outcome:
      outcome.status === 'published'
        ? 'published'
        : outcome.status === 'unknown' || outcome.status === 'accepted_pending'
          ? 'unknown'
          : outcome.code,
    now,
    ...(retryAt ? { retryAt } : {}),
    ...(outcome.status === 'published' ? { externalPostId: outcome.externalPostId } : {}),
    ...(outcome.status === 'unknown' ? { reconciliationKey: outcome.reconciliationKey } : {}),
    ...(outcome.status === 'failed' ? { redactedError: outcome.message } : {}),
  });
  return outcome.status === 'published';
}

export async function dispatchDueFacebookJobs(
  runtime: FacebookDispatchRuntime,
  now = new Date(),
): Promise<number> {
  const jobs = await claimDueJobs(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
    limit: 10,
    destinationProvider: 'facebook_page',
  });
  let published = 0;
  for (const job of jobs) {
    try {
      if (await dispatchJob(runtime, job, now)) published += 1;
    } catch {
      // Leave an uncertain active attempt for lease-expiry reconciliation and continue siblings.
    }
  }
  return published;
}

export async function reconcileFacebookJobs(
  runtime: FacebookDispatchRuntime,
  now = new Date(),
): Promise<number> {
  await recoverExpiredDispatches(runtime.database, now);
  const jobIds = await claimReconciliationJobs(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
    limit: 10,
    destinationProvider: 'facebook_page',
  });
  let resolved = 0;
  for (const jobId of jobIds) {
    try {
      const [job] = await runtime.database
        .select({
          id: publicationJobs.id,
          workspaceId: publicationJobs.workspaceId,
          revisionId: publicationJobs.revisionId,
          providerAccountId: publicationJobs.providerAccountId,
        })
        .from(publicationJobs)
        .where(eq(publicationJobs.id, jobId))
        .limit(1);
      if (!job) continue;
      const context = await loadContext(runtime.database, job.workspaceId, job.id);
      const adapter = await createAdapter(runtime, job, context.credentialId, now);
      const fingerprint = deriveJobIdempotencyKey({
        jobId: job.id,
        revisionId: job.revisionId,
        providerAccountId: job.providerAccountId,
      });
      const outcome = await adapter.publish(
        await adapter.stage(context.accountRemoteId, publishContent(context), fingerprint),
      );
      if (outcome.status !== 'published') continue;
      if (
        await resolveReconciliation(runtime.database, {
          workspaceId: job.workspaceId,
          jobId: job.id,
          workerId: runtime.workerId,
          outcome: 'published',
          now,
          externalPostId: outcome.externalPostId,
        })
      )
        resolved += 1;
    } catch {
      // Keep ambiguous request-started jobs held for operator resolution or a later safe lookup.
    }
  }
  return resolved;
}
