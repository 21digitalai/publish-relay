import { and, asc, eq } from 'drizzle-orm';
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
import { decryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
import { getActiveCredential } from '../credentials/credential.repository.js';
import {
  claimDueJobs,
  claimReconciliationJobs,
  deriveJobIdempotencyKey,
  finishDispatchAttempt,
  recoverExpiredDispatches,
  resolveReconciliation,
  startDispatchAttempt,
} from '../scheduler/job.repository.js';
import { InstagramPublishingAdapter } from './instagram-adapter.js';
import { PostgresInstagramArtifactStore } from './instagram-artifact-store.js';
import type { InstagramHttpClient } from './instagram-http-client.js';
import { getFreshInstagramLoginToken } from './instagram-login-credential.service.js';
import {
  hasExactInstagramLoginScopes,
  type InstagramLoginClient,
} from './instagram-login-client.js';
import type { InstagramMediaTokenCodec } from './instagram-media-token.js';

export interface InstagramDispatchRuntime {
  database: NodePgDatabase;
  keys: MasterKeyProvider;
  client: InstagramHttpClient;
  loginClient?: InstagramHttpClient;
  loginTokenClient?: InstagramLoginClient;
  tokenCodec: InstagramMediaTokenCodec;
  publicOrigin: string;
  workerId: string;
  leaseMs: number;
}

const DEFAULT_INSTAGRAM_RETRY_SECONDS = 5;
const MAX_INSTAGRAM_RETRY_SECONDS = 5 * 60;

export function getInstagramRetryAt(
  outcome: { status: string; code?: string; retryAfterSeconds?: number },
  now: Date,
): Date | undefined {
  if (outcome.status !== 'failed' || !['rate_limit', 'transient'].includes(outcome.code ?? ''))
    return undefined;
  const seconds = Math.min(
    MAX_INSTAGRAM_RETRY_SECONDS,
    Math.max(1, outcome.retryAfterSeconds ?? DEFAULT_INSTAGRAM_RETRY_SECONDS),
  );
  return new Date(now.getTime() + seconds * 1000);
}

async function loadContext(database: NodePgDatabase, workspaceId: string, jobId: string) {
  return withTenantTransaction(database, { workspaceId }, async (transaction) => {
    const rows = await transaction
      .select({
        accountRemoteId: providerAccounts.remoteAccountId,
        availability: providerAccounts.availability,
        credentialId: providerAccounts.credentialId,
        connectionProvider: providerConnections.provider,
        connectionStatus: providerConnections.status,
        connectionSubject: providerConnections.externalSubjectId,
        connectionScopes: providerConnections.scopes,
        connectionCredentialId: providerConnections.credentialId,
        connectionRevokedAt: providerConnections.revokedAt,
        content: postRevisions.content,
        mediaId: revisionMedia.mediaId,
        mimeType: mediaObjects.mimeType,
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
        postRevisions,
        and(
          eq(postRevisions.workspaceId, publicationJobs.workspaceId),
          eq(postRevisions.id, publicationJobs.revisionId),
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
          eq(providerAccounts.destinationProvider, 'instagram'),
        ),
      )
      .orderBy(asc(revisionMedia.position));
    const first = rows[0];
    if (!first?.credentialId || first.availability !== 'active')
      throw new Error('Instagram destination is unavailable');
    if (first.connectionStatus !== 'active' || first.connectionRevokedAt)
      throw new Error('Instagram grant is unavailable');
    if (first.connectionProvider === 'instagram_login') {
      if (
        first.credentialId !== first.connectionCredentialId ||
        !hasExactInstagramLoginScopes(first.connectionScopes) ||
        rows.some((row) => row.mimeType !== 'image/jpeg')
      )
        throw new Error('Instagram Login grant or JPEG media is unavailable');
    } else if (
      first.connectionProvider !== 'meta' &&
      first.connectionProvider !== 'instagram_unified_login'
    ) {
      throw new Error('Unsupported Instagram connection provider');
    }
    return {
      accountRemoteId: first.accountRemoteId,
      credentialId: first.credentialId,
      connectionProvider: first.connectionProvider,
      connectionSubject: first.connectionSubject,
      text: z.object({ text: z.string().min(1) }).parse(first.content).text,
      media: rows.map((row) => ({ id: row.mediaId, mimeType: row.mimeType })),
    };
  });
}

async function dispatchCredential(
  runtime: InstagramDispatchRuntime,
  context: Awaited<ReturnType<typeof loadContext>>,
  workspaceId: string,
  jobId: string,
  now: Date,
) {
  if (context.connectionProvider === 'instagram_login') {
    if (!runtime.loginClient || !runtime.loginTokenClient)
      throw new Error('Instagram Login publishing runtime is unavailable');
    return {
      client: runtime.loginClient,
      token: await getFreshInstagramLoginToken(
        runtime.database,
        runtime.keys,
        runtime.loginTokenClient,
        {
          workspaceId,
          appScopedUserId: context.connectionSubject,
          requestId: `instagram-dispatch:${jobId}`,
          now,
        },
      ),
    };
  }
  return {
    client: runtime.client,
    token: await readToken(runtime, workspaceId, context.credentialId),
  };
}

async function readToken(
  runtime: InstagramDispatchRuntime,
  workspaceId: string,
  credentialId: string,
) {
  const stored = await withTenantTransaction(runtime.database, { workspaceId }, (transaction) =>
    getActiveCredential(transaction, workspaceId, credentialId),
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

async function dispatchJob(
  runtime: InstagramDispatchRuntime,
  job: { id: string; workspaceId: string; revisionId: string; providerAccountId: string },
  now: Date,
) {
  const context = await loadContext(runtime.database, job.workspaceId, job.id);
  const fingerprint = deriveJobIdempotencyKey({
    jobId: job.id,
    revisionId: job.revisionId,
    providerAccountId: job.providerAccountId,
  });
  const { client, token: accessToken } = await dispatchCredential(
    runtime,
    context,
    job.workspaceId,
    job.id,
    now,
  );
  const attempt = await startDispatchAttempt(runtime.database, {
    workspaceId: job.workspaceId,
    jobId: job.id,
    workerId: runtime.workerId,
    fingerprint,
    now,
  });
  if (!attempt) return false;
  const adapter = new InstagramPublishingAdapter({
    client,
    artifacts: new PostgresInstagramArtifactStore(runtime.database, {
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
  const staged = await adapter.stage(
    context.accountRemoteId,
    { kind: 'text', text: context.text, media: context.media },
    fingerprint,
  );
  const outcome = await adapter.publish(staged);
  const retryAt = getInstagramRetryAt(outcome, now);
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
    ...(outcome.status === 'published'
      ? { externalPostId: outcome.externalPostId, externalUrl: outcome.externalUrl }
      : {}),
    ...(outcome.status === 'unknown'
      ? { reconciliationKey: outcome.reconciliationKey }
      : outcome.status === 'accepted_pending'
        ? { reconciliationKey: `instagram:${outcome.providerJobId}` }
        : {}),
    ...(outcome.status === 'failed' ? { redactedError: outcome.message } : {}),
  });
  return outcome.status === 'published';
}

export async function dispatchDueInstagramJobs(
  runtime: InstagramDispatchRuntime,
  now = new Date(),
): Promise<number> {
  const jobs = await claimDueJobs(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
    limit: 10,
    destinationProvider: 'instagram',
    requireMedia: true,
  });
  let published = 0;
  for (const job of jobs) if (await dispatchJob(runtime, job, now)) published += 1;
  return published;
}

export async function reconcileInstagramJobs(
  runtime: InstagramDispatchRuntime,
  now = new Date(),
): Promise<number> {
  await recoverExpiredDispatches(runtime.database, now);
  const jobIds = await claimReconciliationJobs(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
    limit: 10,
    destinationProvider: 'instagram',
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
      const context = await loadContext(runtime.database, job.workspaceId, job.id);
      const { client, token: accessToken } = await dispatchCredential(
        runtime,
        context,
        job.workspaceId,
        job.id,
        now,
      );
      const adapter = new InstagramPublishingAdapter({
        client,
        artifacts: new PostgresInstagramArtifactStore(runtime.database, {
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
      const fingerprint = deriveJobIdempotencyKey({
        jobId: job.id,
        revisionId: job.revisionId,
        providerAccountId: job.providerAccountId,
      });
      const staged = await adapter.stage(
        context.accountRemoteId,
        { kind: 'text', text: context.text, media: context.media },
        fingerprint,
      );
      const outcome = await adapter.publish(staged);
      if (outcome.status === 'unknown' || outcome.status === 'accepted_pending') continue;
      const retryAt = getInstagramRetryAt(outcome, now);
      const state =
        outcome.status === 'published' ? 'published' : retryAt ? 'retry_wait' : 'failed';
      if (
        await resolveReconciliation(runtime.database, {
          workspaceId: job.workspaceId,
          jobId: job.id,
          workerId: runtime.workerId,
          outcome: state,
          now,
          ...(retryAt ? { retryAt } : {}),
          ...(outcome.status === 'published'
            ? { externalPostId: outcome.externalPostId, externalUrl: outcome.externalUrl }
            : {}),
        })
      )
        resolved += 1;
    } catch {
      // Preserve reconciliation ownership for a later lease and continue the bounded batch.
    }
  }
  return resolved;
}
