import { createHash } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  providerAccounts,
  providerConnections,
  providerMediaGrants,
  publicationJobs,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import {
  claimDueJobs,
  finishDispatchAttempt,
  startDispatchAttempt,
  type ClaimedJob,
} from '../scheduler/job.repository.js';
import {
  verifyTikTokPublicationConsent,
  verifyTikTokPublicationConsentInTransaction,
} from './tiktok-consent.service.js';
import { getFreshTikTokTokenWithVersion } from './tiktok-credential.service.js';
import type { TikTokDirectPost, TikTokHttpClient } from './tiktok-http-client.js';
import type { TikTokMediaGrantService } from './tiktok-media-grant.service.js';

const payloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  destinationProvider: z.literal('tiktok'),
  kind: z.literal('video'),
  caption: z.string(),
  mediaId: z.uuid(),
  mediaSha256: z.string().regex(/^[0-9a-f]{64}$/),
  capabilitySnapshotId: z.uuid(),
  credentialVersion: z.number().int().positive(),
  options: z.strictObject({
    privacyLevel: z.enum([
      'PUBLIC_TO_EVERYONE',
      'MUTUAL_FOLLOW_FRIENDS',
      'FOLLOWER_OF_CREATOR',
      'SELF_ONLY',
    ]),
    allowComment: z.boolean(),
    allowDuet: z.boolean(),
    allowStitch: z.boolean(),
    commercialContent: z.enum(['none', 'own_brand', 'branded', 'both']),
    aiGenerated: z.boolean(),
    coverTimestampMs: z.number().int().nonnegative().optional(),
  }),
  musicUsageConfirmed: z.literal(true),
  brandedContentPolicyConfirmed: z.boolean(),
  declarationVersion: z.literal(1),
  consentReceiptId: z.uuid(),
});

export interface TikTokDispatchRuntime {
  database: NodePgDatabase;
  keys: MasterKeyProvider;
  client: TikTokHttpClient;
  grants: TikTokMediaGrantService;
  workerId: string;
  leaseMs: number;
  publicOrigin: string;
  verifiedMediaOrigin: string;
}

async function loadClaimedJob(runtime: TikTokDispatchRuntime, job: ClaimedJob) {
  return withTenantTransaction(runtime.database, { workspaceId: job.workspaceId }, async (tx) => {
    const rows = await tx
      .select({
        postId: publicationJobs.postId,
        revisionId: publicationJobs.revisionId,
        accountId: publicationJobs.providerAccountId,
        payload: publicationJobs.effectivePayload,
        openId: providerConnections.externalSubjectId,
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
      .where(
        and(
          eq(publicationJobs.workspaceId, job.workspaceId),
          eq(publicationJobs.id, job.id),
          eq(publicationJobs.state, 'leased'),
          eq(publicationJobs.leaseOwner, runtime.workerId),
          eq(providerAccounts.destinationProvider, 'tiktok'),
          eq(providerAccounts.availability, 'active'),
          isNull(providerAccounts.disconnectedAt),
          eq(providerConnections.provider, 'tiktok'),
          eq(providerConnections.status, 'active'),
          isNull(providerConnections.revokedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row?.openId || row.openId.startsWith('legacy:'))
      throw new Error('TikTok job or account is unavailable');
    return { ...row, payload: payloadSchema.parse(row.payload) };
  });
}

function assertVerifiedMediaOrigin(runtime: TikTokDispatchRuntime): string {
  const publicOrigin = new URL(runtime.publicOrigin);
  const verified = new URL(runtime.verifiedMediaOrigin);
  if (
    publicOrigin.protocol !== 'https:' ||
    verified.protocol !== 'https:' ||
    publicOrigin.origin !== verified.origin ||
    publicOrigin.pathname !== '/' ||
    verified.pathname !== '/' ||
    publicOrigin.search ||
    verified.search ||
    publicOrigin.hash ||
    verified.hash ||
    publicOrigin.username ||
    publicOrigin.password ||
    verified.username ||
    verified.password
  )
    throw new Error('TikTok pull origin is not the verified media property');
  return verified.origin;
}

export async function dispatchClaimedTikTokJob(
  runtime: TikTokDispatchRuntime,
  job: ClaimedJob,
  now = new Date(),
): Promise<'accepted_pending' | 'outcome_unknown'> {
  const origin = assertVerifiedMediaOrigin(runtime);
  const context = await loadClaimedJob(runtime, job);
  const tokenGrant = await getFreshTikTokTokenWithVersion(
    runtime.database,
    runtime.keys,
    runtime.client,
    {
      workspaceId: job.workspaceId,
      openId: context.openId,
      requestId: job.id,
      now,
    },
  );
  if (tokenGrant.credentialVersion !== context.payload.credentialVersion)
    throw new Error('TikTok credential changed since human consent');
  const creator = await runtime.client.creatorInfo(tokenGrant.token.access_token);
  const consent = await verifyTikTokPublicationConsent(runtime.database, {
    workspaceId: job.workspaceId,
    postId: context.postId,
    revisionId: context.revisionId,
    accountId: context.accountId,
    receiptId: context.payload.consentReceiptId,
    actor: { type: 'worker', id: job.id },
    creator,
  });
  if (
    consent.workspaceId !== job.workspaceId ||
    consent.postId !== context.postId ||
    consent.revisionId !== context.revisionId ||
    consent.accountId !== context.accountId ||
    consent.mediaId !== context.payload.mediaId ||
    consent.mediaSha256 !== context.payload.mediaSha256 ||
    consent.caption !== context.payload.caption ||
    consent.capabilitySnapshotId !== context.payload.capabilitySnapshotId ||
    consent.credentialVersion !== context.payload.credentialVersion ||
    consent.brandedContentPolicyConfirmed !== context.payload.brandedContentPolicyConfirmed ||
    JSON.stringify(consent.options) !== JSON.stringify(context.payload.options)
  )
    throw new Error('TikTok immutable job differs from human consent');
  const grant = await runtime.grants.issue({
    workspaceId: job.workspaceId,
    accountId: context.accountId,
    mediaId: consent.mediaId,
    publicOrigin: origin,
    now,
  });
  const options = consent.options;
  const request: TikTokDirectPost = {
    title: consent.caption,
    privacyLevel: options.privacyLevel,
    disableComment: !options.allowComment,
    disableDuet: !options.allowDuet,
    disableStitch: !options.allowStitch,
    commercialContent: options.commercialContent,
    isAiGenerated: options.aiGenerated,
    videoUrl: grant.url,
    ...(options.coverTimestampMs === undefined
      ? {}
      : { coverTimestampMs: options.coverTimestampMs }),
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const reservationNow = new Date();
  let attempt;
  try {
    attempt = await startDispatchAttempt(runtime.database, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      workerId: runtime.workerId,
      fingerprint,
      tiktokMediaGrantId: grant.id,
      now: reservationNow,
      preflight: async (tx) => {
        const verified = await verifyTikTokPublicationConsentInTransaction(tx, {
          workspaceId: job.workspaceId,
          postId: context.postId,
          revisionId: context.revisionId,
          accountId: context.accountId,
          receiptId: context.payload.consentReceiptId,
          actor: { type: 'worker', id: job.id },
          creator,
        });
        const mediaGrant = await tx
          .select({ id: providerMediaGrants.id })
          .from(providerMediaGrants)
          .where(
            and(
              eq(providerMediaGrants.workspaceId, job.workspaceId),
              eq(providerMediaGrants.id, grant.id),
              eq(providerMediaGrants.mediaId, verified.mediaId),
              eq(providerMediaGrants.mediaSha256, verified.mediaSha256),
              isNull(providerMediaGrants.revokedAt),
            ),
          )
          .limit(1);
        if (!mediaGrant[0] || grant.expiresAt <= new Date())
          throw new Error('TikTok signed media grant is unavailable');
      },
    });
  } catch (error) {
    await runtime.grants.revoke({
      workspaceId: job.workspaceId,
      accountId: context.accountId,
      grantId: grant.id,
    });
    throw error;
  }
  if (!attempt) {
    await runtime.grants.revoke({
      workspaceId: job.workspaceId,
      accountId: context.accountId,
      grantId: grant.id,
    });
    throw new Error('TikTok attempt reservation was lost');
  }
  let publishId: string;
  try {
    publishId = (await runtime.client.initDirectPost(tokenGrant.token.access_token, request))
      .publishId;
  } catch {
    const stored = await finishDispatchAttempt(runtime.database, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      attemptId: attempt.attemptId,
      outcome: 'unknown',
      tiktokInitPhase: 'outcome_unknown',
      reconciliationKey: `tiktok:${job.id}`,
      redactedError: 'TikTok init outcome is unknown; manual attention required',
      now: new Date(),
    });
    if (!stored) throw new Error('TikTok unknown init receipt could not be persisted');
    return 'outcome_unknown';
  }
  const stored = await finishDispatchAttempt(runtime.database, {
    workspaceId: job.workspaceId,
    jobId: job.id,
    attemptId: attempt.attemptId,
    outcome: 'accepted_pending',
    tiktokInitPhase: 'accepted_pending',
    reconciliationKey: `tiktok:${publishId}`,
    providerRequestId: publishId,
    now: new Date(),
  });
  if (!stored) throw new Error('TikTok accepted init receipt could not be persisted');
  return 'accepted_pending';
}

export async function dispatchDueTikTokJobs(
  runtime: TikTokDispatchRuntime,
  now = new Date(),
): Promise<number> {
  assertVerifiedMediaOrigin(runtime);
  const jobs = await claimDueJobs(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
    limit: 1,
    destinationProvider: 'tiktok',
    requireMedia: true,
  });
  let accepted = 0;
  for (const job of jobs)
    if ((await dispatchClaimedTikTokJob(runtime, job, now)) === 'accepted_pending') accepted += 1;
  return accepted;
}
