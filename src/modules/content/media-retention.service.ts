import { sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MediaStorage } from './media-storage.js';

export interface MediaRetentionPolicy {
  cleanupDeadline(input: { workspaceId: string; mediaId: string; retainedAt: Date }): Date | null;
}

export const retainForeverMediaPolicy: MediaRetentionPolicy = {
  cleanupDeadline: () => null,
};

export function createFixedMediaRetentionPolicy(retentionMs: number): MediaRetentionPolicy {
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0)
    throw new Error('Media retention duration must be a non-negative integer');
  return {
    cleanupDeadline: ({ retainedAt }) => new Date(retainedAt.getTime() + retentionMs),
  };
}

interface Candidate extends Record<string, unknown> {
  id: string;
  storage_key: string;
  retained_at: Date;
}

const INSTAGRAM_TERMINAL_GRACE_MS = 24 * 60 * 60 * 1000;

function requiredStagingArtifactPredicate(
  workspaceId: string | SQL,
  mediaId: string | SQL,
  now: Date,
) {
  const terminalBefore = new Date(now.getTime() - INSTAGRAM_TERMINAL_GRACE_MS);
  return sql`
    select 1 from provider_staging_artifacts artifact
    join publication_jobs job
      on job.workspace_id = artifact.workspace_id and job.id = artifact.job_id
    join provider_accounts account
      on account.workspace_id = job.workspace_id and account.id = job.provider_account_id
    where artifact.workspace_id = ${workspaceId} and artifact.media_id = ${mediaId}
      and artifact.deleted_at is null
      and (
        (account.destination_provider <> 'instagram' and artifact.expires_at > ${now})
        or (
          account.destination_provider = 'instagram'
          and (
            artifact.expires_at > ${now}
            or job.state not in ('published', 'failed', 'cancelled', 'superseded')
            or job.reconciliation_required = true
            or job.updated_at >= ${terminalBefore}
          )
        )
      )
  `;
}

async function hasRequiredJobReference(
  database: NodePgDatabase,
  workspaceId: string,
  mediaId: string,
  now: Date,
): Promise<boolean> {
  const result = await database.execute<{ required: boolean }>(sql`
    select exists (
      select 1 from revision_media rm
      join publication_jobs pj on pj.workspace_id = rm.workspace_id and pj.revision_id = rm.revision_id
      where rm.workspace_id = ${workspaceId} and rm.media_id = ${mediaId}
        and (pj.state in ('scheduled', 'leased', 'dispatching', 'retry_wait', 'accepted_pending')
          or pj.reconciliation_required = true)
      union all
      ${requiredStagingArtifactPredicate(workspaceId, mediaId, now)}
    ) as required
  `);
  return result.rows[0]?.required === true;
}

export async function evaluateMediaRetention(
  database: NodePgDatabase,
  input: { workspaceId: string; now: Date; policy?: MediaRetentionPolicy; limit?: number },
): Promise<number> {
  const policy = input.policy ?? retainForeverMediaPolicy;
  return withTenantTransaction(database, input, async (transaction) => {
    const candidates = await transaction.execute<Candidate>(sql`
      select id, storage_key, retained_at from media_objects
      where workspace_id = ${input.workspaceId} and state = 'ready' and retained_at is not null
      order by retained_at, id
      limit ${input.limit ?? 100}
    `);
    let eligible = 0;
    for (const media of candidates.rows) {
      const deadline = policy.cleanupDeadline({
        workspaceId: input.workspaceId,
        mediaId: media.id,
        retainedAt: new Date(media.retained_at),
      });
      if (!deadline || deadline > input.now) continue;
      if (await hasRequiredJobReference(transaction, input.workspaceId, media.id, input.now))
        continue;
      const updated = await transaction.execute(sql`
        update media_objects set state = 'cleanup_eligible', cleanup_eligible_at = ${deadline}, updated_at = ${input.now}
        where workspace_id = ${input.workspaceId} and id = ${media.id} and state = 'ready'
      `);
      eligible += updated.rowCount ?? 0;
    }
    return eligible;
  });
}

export async function cleanupRetainedMedia(
  database: NodePgDatabase,
  storage: MediaStorage,
  input: {
    workspaceId: string;
    now: Date;
    retryDelayMs: number;
    staleClaimBefore: Date;
    limit?: number;
  },
): Promise<{ deleted: number; failed: number }> {
  const candidates = await withTenantTransaction(database, input, async (transaction) => {
    await transaction.execute(sql`
      update media_objects set state = 'cleanup_failed', cleanup_failed_at = ${input.now},
        cleanup_retry_at = ${input.now}, updated_at = ${input.now}
      where workspace_id = ${input.workspaceId} and state = 'deleting'
        and (cleanup_started_at is null or cleanup_started_at < ${input.staleClaimBefore})
    `);
    const result = await transaction.execute<{ id: string; storage_key: string }>(sql`
      with candidates as (
        select media.id
        from media_objects media
        where media.workspace_id = ${input.workspaceId}
          and (media.state = 'cleanup_eligible'
            or (media.state = 'cleanup_failed' and media.cleanup_retry_at <= ${input.now}))
          and not exists (
            select 1 from revision_media rm
            join publication_jobs pj
              on pj.workspace_id = rm.workspace_id and pj.revision_id = rm.revision_id
            where rm.workspace_id = media.workspace_id and rm.media_id = media.id
              and (pj.state in ('scheduled', 'leased', 'dispatching', 'retry_wait', 'accepted_pending')
                or pj.reconciliation_required = true)
          )
          and not exists (
            ${requiredStagingArtifactPredicate(input.workspaceId, sql.raw('media.id'), input.now)}
          )
        order by media.cleanup_eligible_at, media.id
        limit ${input.limit ?? 100}
        for update of media skip locked
      )
      update media_objects media
      set state = 'deleting', cleanup_started_at = ${input.now},
        deletion_attempts = media.deletion_attempts + 1, updated_at = ${input.now}
      from candidates
      where media.workspace_id = ${input.workspaceId} and media.id = candidates.id
      returning media.id, media.storage_key
    `);
    return result.rows;
  });
  let deleted = 0;
  let failed = 0;
  for (const media of candidates) {
    try {
      await storage.delete(media.storage_key);
      await withTenantTransaction(database, input, (transaction) =>
        transaction.execute(sql`
        update media_objects set state = 'deleted', deleted_at = ${input.now}, cleanup_retry_at = null,
          updated_at = ${input.now} where workspace_id = ${input.workspaceId} and id = ${media.id} and state = 'deleting'
      `),
      );
      deleted += 1;
    } catch {
      const retryAt = new Date(input.now.getTime() + input.retryDelayMs);
      await withTenantTransaction(database, input, (transaction) =>
        transaction.execute(sql`
        update media_objects set state = 'cleanup_failed', cleanup_failed_at = ${input.now},
          cleanup_retry_at = ${retryAt}, updated_at = ${input.now}
        where workspace_id = ${input.workspaceId} and id = ${media.id} and state = 'deleting'
      `),
      );
      failed += 1;
    }
  }
  return { deleted, failed };
}

export async function deleteUnattachedMedia(
  database: NodePgDatabase,
  storage: MediaStorage,
  input: { workspaceId: string; mediaId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const claim = await withTenantTransaction(database, input, async (transaction) => {
    const result = await transaction.execute<{ storage_key: string }>(sql`
      update media_objects media
      set state = 'deleting', cleanup_started_at = ${now},
        deletion_attempts = media.deletion_attempts + 1, updated_at = ${now}
      where media.workspace_id = ${input.workspaceId} and media.id = ${input.mediaId}
        and media.state in ('ready', 'cleanup_failed')
        and not exists (
          select 1 from revision_media rm
          where rm.workspace_id = media.workspace_id and rm.media_id = media.id
        )
      returning media.storage_key
    `);
    const claimed = result.rows[0];
    if (claimed) return { kind: 'claimed' as const, storageKey: claimed.storage_key };
    const existing = await transaction.execute<{ state: string }>(sql`
      select state from media_objects
      where workspace_id = ${input.workspaceId} and id = ${input.mediaId}
    `);
    return {
      kind: existing.rows[0]?.state === 'deleted' ? ('deleted' as const) : ('unavailable' as const),
    };
  });
  if (claim.kind === 'deleted') return true;
  if (claim.kind === 'unavailable') return false;
  if (!claim.storageKey) return false;
  try {
    await storage.delete(claim.storageKey);
  } catch (error) {
    await withTenantTransaction(database, input, (transaction) =>
      transaction.execute(sql`
        update media_objects set state = 'cleanup_failed', cleanup_failed_at = ${now},
          cleanup_retry_at = ${now}, updated_at = ${now}
        where workspace_id = ${input.workspaceId} and id = ${input.mediaId} and state = 'deleting'
      `),
    );
    throw error;
  }
  await withTenantTransaction(database, input, (transaction) =>
    transaction.execute(sql`
      update media_objects set state = 'deleted', deleted_at = ${now}, cleanup_retry_at = null,
        updated_at = ${now} where workspace_id = ${input.workspaceId} and id = ${input.mediaId}
        and state = 'deleting'
    `),
  );
  return true;
}
