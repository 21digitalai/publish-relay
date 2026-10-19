import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  credentials,
  providerAccountExposures,
  providerAccounts,
  providerConnections,
  publicationAttempts,
  publicationJobs,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { claimReconciliationJobs, resolveReconciliation } from '../scheduler/job.repository.js';
import { getFreshTikTokTokenWithVersion } from './tiktok-credential.service.js';
import type { TikTokDispatchRuntime } from './tiktok-direct-post-dispatch.service.js';
import { providerPostUrl } from './post-url.js';

async function loadAcceptedAttempt(
  runtime: TikTokDispatchRuntime,
  workspaceId: string,
  jobId: string,
) {
  return withTenantTransaction(runtime.database, { workspaceId }, async (tx) => {
    const rows = await tx
      .select({
        accountId: providerAccounts.id,
        accountSubjectId: providerAccounts.remoteAccountId,
        openId: providerConnections.externalSubjectId,
        publishId: publicationAttempts.providerRequestId,
        credentialVersion: credentials.version,
      })
      .from(publicationJobs)
      .innerJoin(
        publicationAttempts,
        and(
          eq(publicationAttempts.workspaceId, publicationJobs.workspaceId),
          eq(publicationAttempts.jobId, publicationJobs.id),
          eq(publicationAttempts.attemptNumber, publicationJobs.attemptNumber),
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
        credentials,
        and(
          eq(credentials.workspaceId, providerConnections.workspaceId),
          eq(credentials.id, providerConnections.credentialId),
          isNull(credentials.revokedAt),
        ),
      )
      .where(
        and(
          eq(publicationJobs.workspaceId, workspaceId),
          eq(publicationJobs.id, jobId),
          eq(publicationJobs.reconciliationRequired, true),
          eq(publicationJobs.leaseOwner, runtime.workerId),
          eq(publicationAttempts.tiktokInitPhase, 'accepted_pending'),
          eq(providerAccounts.destinationProvider, 'tiktok'),
          eq(providerAccounts.availability, 'active'),
          isNull(providerAccounts.disconnectedAt),
          eq(providerConnections.provider, 'tiktok'),
          eq(providerConnections.status, 'active'),
          isNull(providerConnections.revokedAt),
        ),
      )
      .limit(2);
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row?.publishId ||
      !row.openId ||
      row.openId.startsWith('legacy:') ||
      row.accountSubjectId !== row.openId
    )
      return null;
    return {
      accountId: row.accountId,
      openId: row.openId,
      publishId: row.publishId,
      credentialVersion: row.credentialVersion,
    };
  });
}

export async function revokeExpiredTerminalTikTokGrants(
  database: NodePgDatabase,
  now = new Date(),
): Promise<number> {
  const result = await database.execute<{ id: string }>(sql`
    UPDATE provider_media_grants AS grant_row
    SET revoked_at = ${now}
    WHERE grant_row.revoked_at IS NULL AND grant_row.expires_at <= ${now}
      AND EXISTS (
        SELECT 1 FROM publication_attempts attempt
        JOIN publication_jobs job ON job.workspace_id = attempt.workspace_id
          AND job.id = attempt.job_id
        WHERE attempt.workspace_id = grant_row.workspace_id
          AND attempt.tiktok_media_grant_id = grant_row.id
          AND job.state IN ('published', 'failed', 'cancelled')
      )
    RETURNING grant_row.id
  `);
  return ('rows' in result ? result.rows : result).length;
}

export async function reconcileTikTokDirectPosts(
  runtime: TikTokDispatchRuntime,
  now = new Date(),
): Promise<number> {
  await revokeExpiredTerminalTikTokGrants(runtime.database, now);
  const jobIds = await claimReconciliationJobs(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
    limit: 10,
    destinationProvider: 'tiktok',
  });
  let reconciled = 0;
  for (const jobId of jobIds) {
    try {
      const jobs = await runtime.database
        .select({ workspaceId: publicationJobs.workspaceId })
        .from(publicationJobs)
        .where(eq(publicationJobs.id, jobId))
        .limit(1);
      const workspaceId = jobs[0]?.workspaceId;
      if (!workspaceId) continue;
      const attempt = await loadAcceptedAttempt(runtime, workspaceId, jobId);
      if (!attempt) continue; // No publish ID or current authority: manual attention, never re-init.
      const tokenGrant = await getFreshTikTokTokenWithVersion(
        runtime.database,
        runtime.keys,
        runtime.client,
        {
          workspaceId,
          openId: attempt.openId,
          requestId: jobId,
          now,
        },
      );
      const creator = await runtime.client.creatorInfo(tokenGrant.token.access_token);
      const status = await runtime.client.status(tokenGrant.token.access_token, attempt.publishId);
      const current = await loadAcceptedAttempt(runtime, workspaceId, jobId);
      if (
        current?.publishId !== attempt.publishId ||
        current.openId !== attempt.openId ||
        current.accountId !== attempt.accountId ||
        current.credentialVersion !== tokenGrant.credentialVersion
      )
        continue;
      const outcome =
        status.status === 'PUBLISH_COMPLETE'
          ? 'published'
          : status.status === 'FAILED'
            ? 'failed'
            : 'accepted_pending';
      const postIds = status.publicaly_available_post_id ?? [];
      const externalPostId =
        outcome === 'published' && postIds.length === 1 ? postIds[0] : undefined;
      const externalUrl = externalPostId
        ? providerPostUrl({
            provider: 'tiktok',
            id: externalPostId,
            handle: creator.creator_username,
          })
        : null;
      if (
        await resolveReconciliation(runtime.database, {
          workspaceId,
          jobId,
          workerId: runtime.workerId,
          outcome,
          now,
          ...(outcome === 'accepted_pending'
            ? {}
            : {
                terminalAttempt: {
                  providerRequestId: attempt.publishId,
                  outcome: outcome === 'failed' ? 'permanent' : 'published',
                  ...(outcome === 'failed'
                    ? { redactedError: 'TikTok reported Direct Post failure' }
                    : {}),
                },
              }),
          ...(externalPostId ? { externalPostId, ...(externalUrl ? { externalUrl } : {}) } : {}),
        })
      )
        reconciled += 1;
    } catch {
      // Keep the reconciliation lease for a bounded retry; never call init again.
    }
  }
  return reconciled;
}
