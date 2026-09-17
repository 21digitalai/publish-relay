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
  deriveJobIdempotencyKey,
  finishDispatchAttempt,
  recoverExpiredDispatches,
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

async function dispatchJob(
  runtime: FacebookDispatchRuntime,
  job: { id: string; workspaceId: string; revisionId: string; providerAccountId: string },
  now: Date,
) {
  const context = await loadContext(runtime.database, job.workspaceId, job.id);
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
  const accessToken = await readToken(runtime, job.workspaceId, context.credentialId);
  const adapter = new FacebookPublishingAdapter({
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
  const content: PublishContent =
    context.payload.kind === 'link'
      ? {
          kind: 'link',
          text: context.payload.message,
          url: context.payload.linkUrl,
          media: [],
        }
      : { kind: 'text', text: context.payload.message, media: context.media };
  const outcome = await adapter.publish(
    await adapter.stage(context.accountRemoteId, content, fingerprint),
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
  for (const job of jobs) if (await dispatchJob(runtime, job, now)) published += 1;
  return published;
}

export async function reconcileFacebookJobs(
  runtime: FacebookDispatchRuntime,
  now = new Date(),
): Promise<number> {
  await recoverExpiredDispatches(runtime.database, now);
  return 0;
}
