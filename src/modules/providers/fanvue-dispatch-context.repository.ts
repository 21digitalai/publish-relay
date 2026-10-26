import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { fanvueContentSchema } from '../content/publication-target.js';

export async function loadFanvueDispatchContext(
  database: NodePgDatabase,
  input: { workspaceId: string; jobId: string; leaseOwner: string },
) {
  return withTenantTransaction(database, input, async (transaction) => {
    const result = await transaction.execute<{
      creatorId: string;
      payload: unknown;
      revisionId: string;
    }>(sql`
      SELECT account.remote_account_id AS "creatorId",
        job.effective_payload AS payload, job.revision_id AS "revisionId"
      FROM publication_jobs job
      JOIN provider_accounts account
        ON account.workspace_id = job.workspace_id AND account.id = job.provider_account_id
      JOIN provider_connections connection
        ON connection.workspace_id = account.workspace_id AND connection.id = account.connection_id
      WHERE job.workspace_id = ${input.workspaceId} AND job.id = ${input.jobId}
        AND job.state = 'leased' AND job.lease_owner = ${input.leaseOwner}
        AND job.lease_expires_at > clock_timestamp()
        AND account.destination_provider = 'fanvue'
        AND account.availability = 'active' AND account.disconnected_at IS NULL
        AND connection.provider = 'fanvue' AND connection.status = 'active'
        AND connection.external_subject_id = account.remote_account_id
        AND connection.revoked_at IS NULL
      LIMIT 1
    `);
    const selected = result.rows[0];
    if (!selected) throw new Error('Fanvue publication destination is unavailable');
    const content = fanvueContentSchema.parse(selected.payload);
    const attached = await transaction.execute<{ mediaId: string; state: string }>(sql`
      SELECT attached.media_id AS "mediaId", media.state
      FROM revision_media attached
      JOIN media_objects media
        ON media.workspace_id = attached.workspace_id AND media.id = attached.media_id
      WHERE attached.workspace_id = ${input.workspaceId}
        AND attached.revision_id = ${selected.revisionId}
        AND media.deleted_at IS NULL
      ORDER BY attached.position
    `);
    const mediaIds = attached.rows.map((row) => row.mediaId);
    if (
      mediaIds.length !== content.mediaIds.length ||
      mediaIds.some((mediaId, index) => mediaId !== content.mediaIds[index]) ||
      attached.rows.some((row) => row.state !== 'ready')
    )
      throw new Error('Fanvue post media does not match its ready revision attachments');
    return { creatorId: selected.creatorId, content };
  });
}

/** Recheck account and every ordered media artifact inside attempt reservation. */
export async function assertFanvueDispatchPreflight(
  transaction: NodePgDatabase,
  input: {
    workspaceId: string;
    jobId: string;
    creatorId: string;
    mediaIds: string[];
    readyMedia: ReadonlyMap<string, string>;
  },
): Promise<void> {
  const destination = await transaction.execute<{ id: string }>(sql`
    SELECT job.id
    FROM publication_jobs job
    JOIN provider_accounts account
      ON account.workspace_id = job.workspace_id AND account.id = job.provider_account_id
    JOIN provider_connections connection
      ON connection.workspace_id = account.workspace_id AND connection.id = account.connection_id
    WHERE job.workspace_id = ${input.workspaceId} AND job.id = ${input.jobId}
      AND job.state = 'dispatching'
      AND job.lease_expires_at > clock_timestamp()
      AND account.destination_provider = 'fanvue'
      AND account.remote_account_id = ${input.creatorId}
      AND account.availability = 'active' AND account.disconnected_at IS NULL
      AND connection.provider = 'fanvue' AND connection.status = 'active'
      AND connection.external_subject_id = ${input.creatorId}
      AND connection.revoked_at IS NULL
    LIMIT 1
  `);
  if (!destination.rows[0]) throw new Error('Fanvue destination changed before dispatch');
  const result = await transaction.execute<{ mediaId: string; mediaUuid: string | null }>(sql`
    SELECT attached.media_id AS "mediaId", artifact.external_object_id AS "mediaUuid"
    FROM publication_jobs job
    JOIN revision_media attached
      ON attached.workspace_id = job.workspace_id AND attached.revision_id = job.revision_id
    JOIN media_objects media
      ON media.workspace_id = attached.workspace_id AND media.id = attached.media_id
    LEFT JOIN provider_staging_artifacts artifact
      ON artifact.workspace_id = job.workspace_id AND artifact.job_id = job.id
      AND artifact.media_id = media.id AND artifact.provider_reference = 'fanvue:multipart'
      AND artifact.upload_phase = 'finalized' AND artifact.deleted_at IS NULL
      AND artifact.expires_at > clock_timestamp()
    WHERE job.workspace_id = ${input.workspaceId} AND job.id = ${input.jobId}
      AND media.state = 'ready' AND media.deleted_at IS NULL
    ORDER BY attached.position
  `);
  if (
    result.rows.length !== input.mediaIds.length ||
    result.rows.some(
      (row, index) =>
        row.mediaId !== input.mediaIds[index] ||
        !row.mediaUuid ||
        row.mediaUuid !== input.readyMedia.get(row.mediaId),
    )
  )
    throw new Error('Fanvue media changed before dispatch');
}
