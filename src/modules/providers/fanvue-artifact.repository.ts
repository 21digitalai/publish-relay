import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { getActiveCredential } from '../credentials/credential.repository.js';
import { decryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
import { parseFanvueUploadSession, type FanvueUploadSession } from './fanvue-upload-session.js';

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
            AND (attempt.finished_at IS NULL OR attempt.outcome NOT IN
              ('rate_limit', 'auth', 'validation', 'transient', 'permanent'))
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
            AND (attempt.finished_at IS NULL OR attempt.outcome NOT IN
              ('rate_limit', 'auth', 'validation', 'transient', 'permanent'))
        )
      LIMIT 1
    `);
    return existing.rows[0]?.id ?? null;
  });
}

/** Return only provider-ready UUIDs attached to the selected live job revision. */
export async function getFinalizedFanvueMediaUuids(
  database: NodePgDatabase,
  input: { workspaceId: string; jobId: string; leaseOwner: string },
): Promise<Map<string, string>> {
  return withTenantTransaction(database, input, async (transaction) => {
    const result = await transaction.execute<{ mediaId: string; mediaUuid: string }>(sql`
      SELECT artifact.media_id AS "mediaId", artifact.external_object_id AS "mediaUuid"
      FROM publication_jobs job
      JOIN provider_accounts account
        ON account.workspace_id = job.workspace_id AND account.id = job.provider_account_id
      JOIN revision_media attached
        ON attached.workspace_id = job.workspace_id AND attached.revision_id = job.revision_id
      JOIN media_objects media
        ON media.workspace_id = attached.workspace_id AND media.id = attached.media_id
      JOIN provider_staging_artifacts artifact
        ON artifact.workspace_id = job.workspace_id AND artifact.job_id = job.id
        AND artifact.media_id = media.id
      WHERE job.workspace_id = ${input.workspaceId} AND job.id = ${input.jobId}
        AND job.state = 'leased' AND job.lease_owner = ${input.leaseOwner}
        AND job.lease_expires_at > clock_timestamp()
        AND account.destination_provider = 'fanvue'
        AND account.availability = 'active' AND account.disconnected_at IS NULL
        AND media.state = 'ready' AND media.deleted_at IS NULL
        AND artifact.provider_reference = 'fanvue:multipart'
        AND artifact.upload_phase = 'finalized'
        AND artifact.external_object_id IS NOT NULL
        AND artifact.deleted_at IS NULL AND artifact.expires_at > clock_timestamp()
        AND NOT EXISTS (
          SELECT 1 FROM publication_attempts attempt
          WHERE attempt.workspace_id = job.workspace_id AND attempt.job_id = job.id
            AND (attempt.finished_at IS NULL OR attempt.outcome NOT IN
              ('rate_limit', 'auth', 'validation', 'transient', 'permanent'))
        )
    `);
    return new Map(result.rows.map((row) => [row.mediaId, row.mediaUuid]));
  });
}

export interface FanvueStagingProgress {
  artifactId: string;
  phase: string;
  mediaUuid: string | null;
  session: FanvueUploadSession | null;
  credentialId: string | null;
  credentialVersion: number | null;
}

/** Resume only the exact attached media artifact; pending external requests stay pending. */
export async function getFanvueStagingProgress(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: { workspaceId: string; jobId: string; mediaId: string; leaseOwner: string },
): Promise<FanvueStagingProgress | null> {
  return withTenantTransaction(database, input, async (transaction) => {
    const result = await transaction.execute<{
      artifactId: string;
      phase: string;
      mediaUuid: string | null;
      credentialId: string | null;
    }>(sql`
      SELECT artifact.id AS "artifactId", artifact.upload_phase AS phase,
        artifact.external_object_id AS "mediaUuid",
        artifact.provider_reference_credential_id AS "credentialId"
      FROM publication_jobs job
      JOIN provider_accounts account
        ON account.workspace_id = job.workspace_id AND account.id = job.provider_account_id
      JOIN revision_media attached
        ON attached.workspace_id = job.workspace_id AND attached.revision_id = job.revision_id
      JOIN media_objects media
        ON media.workspace_id = attached.workspace_id AND media.id = attached.media_id
      JOIN provider_staging_artifacts artifact
        ON artifact.workspace_id = job.workspace_id AND artifact.job_id = job.id
        AND artifact.media_id = media.id
      WHERE job.workspace_id = ${input.workspaceId} AND job.id = ${input.jobId}
        AND job.state = 'leased' AND job.lease_owner = ${input.leaseOwner}
        AND job.lease_expires_at > clock_timestamp()
        AND account.destination_provider = 'fanvue'
        AND account.availability = 'active' AND account.disconnected_at IS NULL
        AND media.id = ${input.mediaId} AND media.state = 'ready' AND media.deleted_at IS NULL
        AND artifact.provider_reference = 'fanvue:multipart'
        AND artifact.deleted_at IS NULL AND artifact.expires_at > clock_timestamp()
        AND NOT EXISTS (
          SELECT 1 FROM publication_attempts attempt
          WHERE attempt.workspace_id = job.workspace_id AND attempt.job_id = job.id
            AND (attempt.finished_at IS NULL OR attempt.outcome NOT IN
              ('rate_limit', 'auth', 'validation', 'transient', 'permanent'))
        )
      LIMIT 1
    `);
    const artifact = result.rows[0];
    if (!artifact) return null;
    if (artifact.phase !== 'uploading')
      return { ...artifact, session: null, credentialVersion: null };
    if (!artifact.credentialId) throw new Error('Fanvue upload session credential is unavailable');
    const stored = await getActiveCredential(transaction, input.workspaceId, artifact.credentialId);
    if (!stored) throw new Error('Fanvue upload session credential is unavailable');
    const plaintext = await decryptCredential(stored, keys);
    try {
      const session = parseFanvueUploadSession(JSON.parse(plaintext.toString('utf8')) as unknown);
      return { ...artifact, session, credentialVersion: stored.version };
    } finally {
      plaintext.fill(0);
    }
  });
}
