import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';

interface ReservationInput {
  workspaceId: string;
  jobId: string;
  mediaId: string;
  leaseOwner: string;
  expiresAt: Date;
}

/** An ineligible job cannot leave a new durable provider resource owner behind. */
export async function reserveFanvueStagingArtifact(
  database: NodePgDatabase,
  input: ReservationInput,
): Promise<string | null> {
  return withTenantTransaction(database, input, async (transaction) => {
    const result = await transaction.execute<{ id: string }>(sql`
      INSERT INTO provider_staging_artifacts
        (workspace_id, job_id, media_id, provider_reference, expires_at)
      SELECT job.workspace_id, job.id, media.id, 'fanvue:multipart', ${input.expiresAt}
      FROM publication_jobs job
      JOIN provider_accounts account
        ON account.workspace_id = job.workspace_id AND account.id = job.provider_account_id
      JOIN revision_media attached
        ON attached.workspace_id = job.workspace_id AND attached.revision_id = job.revision_id
      JOIN media_objects media
        ON media.workspace_id = attached.workspace_id AND media.id = attached.media_id
      WHERE job.workspace_id = ${input.workspaceId} AND job.id = ${input.jobId}
        AND job.state = 'leased' AND job.lease_owner = ${input.leaseOwner}
        AND job.lease_expires_at > clock_timestamp()
        AND account.destination_provider = 'fanvue'
        AND account.availability = 'active' AND account.disconnected_at IS NULL
        AND media.id = ${input.mediaId} AND media.state = 'ready'
        AND media.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM publication_attempts attempt
          WHERE attempt.workspace_id = job.workspace_id AND attempt.job_id = job.id
        )
      ON CONFLICT DO NOTHING RETURNING id
    `);
    if (result.rows[0]) return result.rows[0].id;
    const existing = await transaction.execute<{ id: string }>(sql`
      SELECT artifact.id
      FROM provider_staging_artifacts artifact
      JOIN publication_jobs job
        ON job.workspace_id = artifact.workspace_id AND job.id = artifact.job_id
      JOIN provider_accounts account
        ON account.workspace_id = job.workspace_id AND account.id = job.provider_account_id
      JOIN revision_media attached
        ON attached.workspace_id = job.workspace_id AND attached.revision_id = job.revision_id
      JOIN media_objects media
        ON media.workspace_id = attached.workspace_id AND media.id = attached.media_id
      WHERE artifact.workspace_id = ${input.workspaceId}
        AND artifact.job_id = ${input.jobId} AND artifact.media_id = ${input.mediaId}
        AND artifact.provider_reference = 'fanvue:multipart'
        AND artifact.upload_phase = 'initialized'
        AND artifact.provider_reference_credential_id IS NULL
        AND artifact.deleted_at IS NULL AND artifact.expires_at > clock_timestamp()
        AND job.state = 'leased' AND job.lease_owner = ${input.leaseOwner}
        AND job.lease_expires_at > clock_timestamp()
        AND account.destination_provider = 'fanvue'
        AND account.availability = 'active' AND account.disconnected_at IS NULL
        AND media.id = ${input.mediaId} AND media.state = 'ready'
        AND media.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM publication_attempts attempt
          WHERE attempt.workspace_id = job.workspace_id AND attempt.job_id = job.id
        )
      LIMIT 1
    `);
    return existing.rows[0]?.id ?? null;
  });
}
