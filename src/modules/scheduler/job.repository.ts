import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

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
      SELECT id
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
    UPDATE publication_jobs AS job
    SET state = 'leased', lease_owner = ${input.workerId}, lease_expires_at = ${leaseExpiresAt},
        attempt_number = job.attempt_number + 1, updated_at = ${input.now}
    FROM candidates
    WHERE job.id = candidates.id
    RETURNING job.id, job.workspace_id AS "workspaceId", job.revision_id AS "revisionId",
      job.provider_account_id AS "providerAccountId", job.state, job.attempt_number AS "attemptNumber",
      job.lease_owner AS "leaseOwner", job.lease_expires_at AS "leaseExpiresAt"
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
