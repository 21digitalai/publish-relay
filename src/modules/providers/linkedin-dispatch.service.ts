import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  postRevisions,
  providerAccounts,
  providerConnections,
  publicationJobs,
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
import { calculateFullJitterDelay } from '../scheduler/retry-policy.js';
import {
  LinkedInRequestError,
  type LinkedInCredential,
  type LinkedInHttpClient,
} from './linkedin-http-client.js';
import { validateLinkedInTextContent } from './linkedin-content.js';

const credentialSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.iso.datetime(),
  memberUrn: z.string().regex(/^urn:li:person:[^\s]+$/),
  scope: z.string().min(1),
});
const contentSchema = z.looseObject({ text: z.string().trim().min(1).max(3_000) });
const LINKEDIN_RETRY_POLICY = { baseDelayMs: 30_000, maximumDelayMs: 900_000, maximumAttempts: 5 };

export function classifyLinkedInDispatchFailure(
  error: unknown,
  attemptNumber: number,
  now: Date,
  random: () => number = Math.random,
): { outcome: 'unknown' | LinkedInRequestError['kind']; retryAt?: Date } {
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
      .where(
        and(
          eq(publicationJobs.workspaceId, workspaceId),
          eq(publicationJobs.id, jobId),
          eq(providerConnections.provider, 'linkedin'),
          isNull(providerAccounts.disconnectedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error('LinkedIn destination is unavailable');
    const content = contentSchema.parse(row.content);
    validateLinkedInTextContent(content, []);
    const stored = await getActiveCredential(transaction, workspaceId, row.credentialId);
    if (!stored) throw new Error('LinkedIn credential is unavailable');
    return { ...row, text: content.text, stored };
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
  let connectionId: string | undefined;
  try {
    const context = await loadJob(runtime, job.workspaceId, job.id);
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
    const externalPostId = await runtime.client.publishText({ credential, text: context.text });
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
    const failure = classifyLinkedInDispatchFailure(error, attempt.attemptNumber, now);
    await finishDispatchAttempt(runtime.database, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      attemptId: attempt.attemptId,
      outcome: failure.outcome,
      now,
      ...(failure.retryAt ? { retryAt: failure.retryAt } : {}),
      ...(failure.outcome === 'unknown' ? { reconciliationKey: `linkedin:${job.id}` } : {}),
      redactedError: requestError?.message ?? 'LinkedIn dispatch outcome is unknown',
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
