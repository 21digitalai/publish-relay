import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerStagingArtifacts } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { createCredential } from '../credentials/credential.repository.js';
import { encryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
import { parseFanvueUploadSession, type FanvueUploadSession } from './fanvue-upload-session.js';

interface InitInput {
  workspaceId: string;
  jobId: string;
  mediaId: string;
  artifactId: string;
  leaseOwner: string;
}

const artifactIdentity = (input: InitInput) =>
  and(
    eq(providerStagingArtifacts.workspaceId, input.workspaceId),
    eq(providerStagingArtifacts.jobId, input.jobId),
    eq(providerStagingArtifacts.mediaId, input.mediaId),
    eq(providerStagingArtifacts.id, input.artifactId),
    eq(providerStagingArtifacts.providerReference, 'fanvue:multipart'),
    isNull(providerStagingArtifacts.deletedAt),
  );

/** Commit create-session intent before the provider request; do not retry a pending call. */
export async function reserveFanvueUploadSession(
  database: NodePgDatabase,
  input: InitInput,
): Promise<boolean> {
  return withTenantTransaction(database, input, async (transaction) => {
    const [artifact] = await transaction
      .update(providerStagingArtifacts)
      .set({ uploadPhase: 'session_pending', updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          artifactIdentity(input),
          eq(providerStagingArtifacts.uploadPhase, 'initialized'),
          isNull(providerStagingArtifacts.providerReferenceCredentialId),
          eq(providerStagingArtifacts.nextSegment, 0),
          eq(providerStagingArtifacts.nextByteOffset, 0),
          gt(providerStagingArtifacts.expiresAt, sql`clock_timestamp()`),
          sql`EXISTS (
          SELECT 1 FROM publication_jobs job
          JOIN provider_accounts account
            ON account.workspace_id = job.workspace_id AND account.id = job.provider_account_id
          JOIN revision_media attached
            ON attached.workspace_id = job.workspace_id AND attached.revision_id = job.revision_id
          JOIN media_objects media
            ON media.workspace_id = attached.workspace_id AND media.id = attached.media_id
          WHERE job.workspace_id = ${input.workspaceId}
            AND job.id = ${input.jobId} AND job.state = 'leased'
            AND job.lease_owner = ${input.leaseOwner}
            AND job.lease_expires_at > clock_timestamp()
            AND account.destination_provider = 'fanvue'
            AND account.availability = 'active' AND account.disconnected_at IS NULL
            AND media.id = ${input.mediaId} AND media.state = 'ready' AND media.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM publication_attempts attempt
              WHERE attempt.workspace_id = job.workspace_id AND attempt.job_id = job.id
                AND (attempt.finished_at IS NULL OR attempt.outcome NOT IN
                  ('rate_limit', 'auth', 'validation', 'transient', 'permanent'))
            )
        )`,
        ),
      )
      .returning({ id: providerStagingArtifacts.id });
    return Boolean(artifact);
  });
}

/** Persist a successful provider session even if the worker lease expired after the call. */
export async function recordFanvueUploadSession(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: InitInput & { session: FanvueUploadSession },
): Promise<{ credentialId: string; credentialVersion: number } | null> {
  const session = parseFanvueUploadSession(input.session);
  if (session.parts.length !== 0) throw new Error('New Fanvue upload session has part receipts');
  const plaintext = Buffer.from(JSON.stringify(session));
  let encrypted;
  try {
    encrypted = await encryptCredential(plaintext, keys);
  } finally {
    plaintext.fill(0);
  }
  return withTenantTransaction(database, input, async (transaction) => {
    const [artifact] = await transaction
      .update(providerStagingArtifacts)
      .set({ uploadPhase: 'uploading', updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          artifactIdentity(input),
          eq(providerStagingArtifacts.uploadPhase, 'session_pending'),
          isNull(providerStagingArtifacts.providerReferenceCredentialId),
        ),
      )
      .returning({ id: providerStagingArtifacts.id });
    if (!artifact) return null;
    const credential = await createCredential(transaction, input.workspaceId, encrypted);
    await transaction
      .update(providerStagingArtifacts)
      .set({ providerReferenceCredentialId: credential.id, updatedAt: sql`clock_timestamp()` })
      .where(and(artifactIdentity(input), eq(providerStagingArtifacts.uploadPhase, 'uploading')));
    return { credentialId: credential.id, credentialVersion: credential.version };
  });
}
