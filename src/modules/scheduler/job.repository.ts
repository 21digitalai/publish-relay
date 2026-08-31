import { createHash } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  publicationAttempts,
  publicationJobEvents,
  publicationJobs,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export interface ClaimedJob extends Record<string, unknown> {
  id: string;
  workspaceId: string;
  revisionId: string;
  providerAccountId: string;
  state: 'leased';
  attemptNumber: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
}

export type AttemptOutcome =
  | 'published'
  | 'accepted_pending'
  | 'unknown'
  | 'auth'
  | 'rate_limit'
  | 'validation'
  | 'transient'
  | 'permanent';

export function deriveJobIdempotencyKey(input: {
  jobId: string;
  revisionId: string;
  providerAccountId: string;
}): string {
  return createHash('sha256')
    .update(`${input.jobId}:${input.revisionId}:${input.providerAccountId}`)
    .digest('hex');
}

function resultRows<T>(result: { rows?: T[] } | T[]): T[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

export async function claimDueJobs(
  database: NodePgDatabase,
  input: { workerId: string; now: Date; leaseMs: number; limit: number },
): Promise<ClaimedJob[]> {
  if (input.limit < 1) return [];
  const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
  const result = await database.execute<ClaimedJob>(sql`
    WITH candidates AS (
      SELECT id, state AS from_state
      FROM publication_jobs
      WHERE (
        (state = 'scheduled' AND scheduled_at <= ${input.now}) OR
        (state = 'retry_wait' AND next_attempt_at <= ${input.now}) OR
        (state = 'leased' AND lease_expires_at <= ${input.now})
      )
      ORDER BY COALESCE(next_attempt_at, scheduled_at), id
      FOR UPDATE SKIP LOCKED
      LIMIT ${input.limit}
    )
    , claimed AS (
      UPDATE publication_jobs AS job
      SET state = 'leased', lease_owner = ${input.workerId}, lease_expires_at = ${leaseExpiresAt},
          attempt_number = job.attempt_number + 1, updated_at = ${input.now}
      FROM candidates WHERE job.id = candidates.id
      RETURNING job.*, candidates.from_state
    ), events AS (
      INSERT INTO publication_job_events (workspace_id, job_id, from_state, to_state, reason)
      SELECT workspace_id, id, from_state, 'leased', 'worker_claim' FROM claimed
    )
    SELECT id, workspace_id AS "workspaceId", revision_id AS "revisionId",
      provider_account_id AS "providerAccountId", state, attempt_number AS "attemptNumber",
      lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt" FROM claimed
  `);
  return resultRows(result);
}

export async function recoverExpiredDispatches(
  database: NodePgDatabase,
  now: Date,
): Promise<string[]> {
  const result = await database.execute<{ id: string }>(sql`
    UPDATE publication_jobs
    SET reconciliation_required = true, lease_owner = null, lease_expires_at = null,
        updated_at = ${now}
    WHERE state = 'dispatching' AND lease_expires_at <= ${now}
      AND reconciliation_required = false
    RETURNING id
  `);
  return resultRows(result).map((row) => row.id);
}

export async function claimReconciliationJobs(
  database: NodePgDatabase,
  input: { workerId: string; now: Date; leaseMs: number; limit: number },
): Promise<string[]> {
  const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
  const result = await database.execute<{ id: string }>(sql`
    WITH candidates AS (
      SELECT id FROM publication_jobs
      WHERE reconciliation_required = true
        AND state IN ('dispatching', 'accepted_pending')
        AND (lease_expires_at IS NULL OR lease_expires_at <= ${input.now})
      ORDER BY updated_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${input.limit}
    )
    UPDATE publication_jobs AS job
    SET lease_owner = ${input.workerId}, lease_expires_at = ${leaseExpiresAt}, updated_at = ${input.now}
    FROM candidates WHERE job.id = candidates.id
    RETURNING job.id
  `);
  return resultRows(result).map((row) => row.id);
}

export async function startDispatchAttempt(
  database: NodePgDatabase,
  input: { workspaceId: string; jobId: string; workerId: string; fingerprint: string; now: Date },
): Promise<{ attemptId: string; attemptNumber: number; idempotencyKey: string } | null> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const jobs = await transaction
        .update(publicationJobs)
        .set({ state: 'dispatching', updatedAt: input.now })
        .where(
          and(
            eq(publicationJobs.workspaceId, input.workspaceId),
            eq(publicationJobs.id, input.jobId),
            eq(publicationJobs.state, 'leased'),
            eq(publicationJobs.leaseOwner, input.workerId),
            gt(publicationJobs.leaseExpiresAt, input.now),
          ),
        )
        .returning({
          revisionId: publicationJobs.revisionId,
          providerAccountId: publicationJobs.providerAccountId,
          attemptNumber: publicationJobs.attemptNumber,
        });
      const job = jobs[0];
      if (!job) return null;
      const idempotencyKey = deriveJobIdempotencyKey({
        jobId: input.jobId,
        revisionId: job.revisionId,
        providerAccountId: job.providerAccountId,
      });
      const attempts = await transaction
        .insert(publicationAttempts)
        .values({
          workspaceId: input.workspaceId,
          jobId: input.jobId,
          attemptNumber: job.attemptNumber,
          idempotencyKey,
          requestFingerprint: input.fingerprint,
          startedAt: input.now,
        })
        .returning({ id: publicationAttempts.id });
      await transaction.insert(publicationJobEvents).values({
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        fromState: 'leased',
        toState: 'dispatching',
        reason: 'worker_dispatch',
      });
      const attempt = attempts[0];
      if (!attempt) throw new Error('Attempt write returned no record');
      return { attemptId: attempt.id, attemptNumber: job.attemptNumber, idempotencyKey };
    },
  );
}

function outcomeState(
  outcome: AttemptOutcome,
  retryAt?: Date,
): 'published' | 'accepted_pending' | 'dispatching' | 'retry_wait' | 'failed' {
  if (outcome === 'published' || outcome === 'accepted_pending') return outcome;
  if (outcome === 'unknown') return 'dispatching';
  if ((outcome === 'rate_limit' || outcome === 'transient') && retryAt) return 'retry_wait';
  return 'failed';
}

export async function finishDispatchAttempt(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    jobId: string;
    attemptId: string;
    outcome: AttemptOutcome;
    now: Date;
    retryAt?: Date;
    providerRequestId?: string;
    externalPostId?: string;
    reconciliationKey?: string;
    redactedError?: string;
  },
): Promise<boolean> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const attempts = await transaction
        .update(publicationAttempts)
        .set({
          finishedAt: input.now,
          outcome: input.outcome,
          retryAt: input.retryAt,
          providerRequestId: input.providerRequestId,
          externalPostId: input.externalPostId,
          reconciliationKey: input.reconciliationKey,
          redactedError: input.redactedError,
        })
        .where(
          and(
            eq(publicationAttempts.workspaceId, input.workspaceId),
            eq(publicationAttempts.id, input.attemptId),
            eq(publicationAttempts.jobId, input.jobId),
            sql`${publicationAttempts.finishedAt} IS NULL`,
          ),
        )
        .returning({ id: publicationAttempts.id });
      if (attempts.length === 0) return false;
      const toState = outcomeState(input.outcome, input.retryAt);
      const jobs = await transaction
        .update(publicationJobs)
        .set({
          state: toState,
          nextAttemptAt: toState === 'retry_wait' ? input.retryAt : null,
          reconciliationRequired:
            input.outcome === 'unknown' || input.outcome === 'accepted_pending',
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(publicationJobs.workspaceId, input.workspaceId),
            eq(publicationJobs.id, input.jobId),
            eq(publicationJobs.state, 'dispatching'),
          ),
        )
        .returning({ id: publicationJobs.id });
      if (jobs.length === 0)
        throw new Error('Dispatching job was not available for attempt completion');
      await transaction.insert(publicationJobEvents).values({
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        fromState: 'dispatching',
        toState,
        reason: `attempt_${input.outcome}`,
        metadata: { attemptId: input.attemptId },
      });
      return true;
    },
  );
}

export async function requestOperatorRetry(
  database: NodePgDatabase,
  input: { workspaceId: string; jobId: string; actorId: string; now: Date },
): Promise<'scheduled' | 'conflict'> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const jobs = await transaction
        .update(publicationJobs)
        .set({ state: 'retry_wait', nextAttemptAt: input.now, updatedAt: input.now })
        .where(
          and(
            eq(publicationJobs.workspaceId, input.workspaceId),
            eq(publicationJobs.id, input.jobId),
            eq(publicationJobs.state, 'failed'),
            eq(publicationJobs.reconciliationRequired, false),
          ),
        )
        .returning({ id: publicationJobs.id });
      if (jobs.length === 0) return 'conflict';
      await transaction.insert(publicationJobEvents).values({
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        fromState: 'failed',
        toState: 'retry_wait',
        reason: 'operator_retry',
        metadata: { actorId: input.actorId },
      });
      return 'scheduled';
    },
  );
}

export async function resolveReconciliation(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    jobId: string;
    workerId: string;
    outcome: 'published' | 'accepted_pending' | 'retry_wait' | 'failed';
    now: Date;
    retryAt?: Date;
  },
): Promise<boolean> {
  if (input.outcome === 'retry_wait' && !input.retryAt)
    throw new Error('retryAt is required for a reconciliation retry');
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const result = await transaction.execute<{
        fromState: 'dispatching' | 'accepted_pending';
      }>(sql`
      WITH candidate AS (
        SELECT id, state FROM publication_jobs
        WHERE workspace_id = ${input.workspaceId} AND id = ${input.jobId}
          AND reconciliation_required = true AND lease_owner = ${input.workerId}
          AND lease_expires_at > ${input.now}
          AND state IN ('dispatching', 'accepted_pending')
        FOR UPDATE
      )
      UPDATE publication_jobs AS job
      SET state = ${input.outcome},
        reconciliation_required = ${input.outcome === 'accepted_pending'},
        next_attempt_at = ${input.outcome === 'retry_wait' ? input.retryAt : null},
        lease_owner = null, lease_expires_at = null, updated_at = ${input.now}
      FROM candidate WHERE job.id = candidate.id
      RETURNING candidate.state AS "fromState"
    `);
      const job = resultRows(result)[0];
      if (!job) return false;
      if (job.fromState !== input.outcome)
        await transaction.insert(publicationJobEvents).values({
          workspaceId: input.workspaceId,
          jobId: input.jobId,
          fromState: job.fromState,
          toState: input.outcome,
          reason: 'reconciliation_resolved',
        });
      return true;
    },
  );
}

export async function cancelPendingJob(
  database: NodePgDatabase,
  input: { workspaceId: string; jobId: string; actorId: string; now: Date },
): Promise<boolean> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const result = await transaction.execute<{ fromState: 'scheduled' | 'retry_wait' }>(sql`
      WITH candidate AS (
        SELECT id, state FROM publication_jobs
        WHERE workspace_id = ${input.workspaceId} AND id = ${input.jobId}
          AND state IN ('scheduled', 'retry_wait')
        FOR UPDATE
      )
      UPDATE publication_jobs AS job
      SET state = 'cancelled', next_attempt_at = null, updated_at = ${input.now}
      FROM candidate
      WHERE job.id = candidate.id
      RETURNING candidate.state AS "fromState"
    `);
      const job = resultRows(result)[0];
      if (!job) return false;
      await transaction.insert(publicationJobEvents).values({
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        fromState: job.fromState,
        toState: 'cancelled',
        reason: 'operator_cancel',
        metadata: { actorId: input.actorId },
      });
      return true;
    },
  );
}

export async function extendOwnedLease(
  database: NodePgDatabase,
  input: { workspaceId: string; jobId: string; workerId: string; now: Date; leaseMs: number },
): Promise<boolean> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const rows = await transaction
        .update(publicationJobs)
        .set({
          leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
          updatedAt: input.now,
        })
        .where(
          and(
            eq(publicationJobs.workspaceId, input.workspaceId),
            eq(publicationJobs.id, input.jobId),
            eq(publicationJobs.leaseOwner, input.workerId),
            sql`${publicationJobs.state} IN ('leased', 'dispatching', 'accepted_pending')`,
            gt(publicationJobs.leaseExpiresAt, input.now),
          ),
        )
        .returning({ id: publicationJobs.id });
      return rows.length === 1;
    },
  );
}
