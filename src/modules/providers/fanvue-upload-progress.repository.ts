import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerStagingArtifacts } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { rotateCredential } from '../credentials/credential.repository.js';
import { encryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
import { fanvuePartRange } from './fanvue-media-upload-plan.js';
import { appendFanvuePartReceipt, type FanvueUploadSession } from './fanvue-upload-session.js';

interface AdvanceFanvueUploadInput {
  workspaceId: string;
  jobId: string;
  artifactId: string;
  leaseOwner: string;
  credentialId: string;
  credentialVersion: number;
  session: FanvueUploadSession;
  partNumber: number;
  etag: string;
  now: Date;
}

/** Commit an encrypted part receipt and its offset together, or preserve both old values. */
export async function advanceFanvueUploadProgress(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: AdvanceFanvueUploadInput,
): Promise<boolean> {
  const receipt = appendFanvuePartReceipt(input.session, input.partNumber, input.etag);
  const expectedSegment = input.partNumber - 1;
  const expectedByteOffset =
    expectedSegment === 0 ? 0 : fanvuePartRange(input.session, expectedSegment).end + 1;
  const plaintext = Buffer.from(JSON.stringify(receipt.state));
  let encryptedSession;
  try {
    encryptedSession = await encryptCredential(plaintext, keys);
  } finally {
    plaintext.fill(0);
  }

  return withTenantTransaction(database, input, async (transaction) => {
    const [artifact] = await transaction
      .update(providerStagingArtifacts)
      .set({
        nextSegment: input.partNumber,
        nextByteOffset: receipt.nextByteOffset,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(providerStagingArtifacts.workspaceId, input.workspaceId),
          eq(providerStagingArtifacts.jobId, input.jobId),
          eq(providerStagingArtifacts.id, input.artifactId),
          eq(providerStagingArtifacts.providerReferenceCredentialId, input.credentialId),
          eq(providerStagingArtifacts.uploadPhase, 'uploading'),
          eq(providerStagingArtifacts.nextSegment, expectedSegment),
          eq(providerStagingArtifacts.nextByteOffset, expectedByteOffset),
          gt(providerStagingArtifacts.expiresAt, input.now),
          isNull(providerStagingArtifacts.deletedAt),
          sql`EXISTS (
            SELECT 1 FROM publication_jobs job
            JOIN provider_accounts account
              ON account.workspace_id = job.workspace_id AND account.id = job.provider_account_id
            WHERE job.workspace_id = ${input.workspaceId}
              AND job.id = ${input.jobId}
              AND job.state = 'leased'
              AND job.lease_owner = ${input.leaseOwner}
              AND job.lease_expires_at > ${input.now}
              AND account.destination_provider = 'fanvue'
              AND account.availability = 'active'
              AND account.disconnected_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM publication_attempts attempt
                WHERE attempt.workspace_id = job.workspace_id AND attempt.job_id = job.id
              )
          )`,
        ),
      )
      .returning({ id: providerStagingArtifacts.id });
    if (!artifact) return false;

    const rotated = await rotateCredential(
      transaction,
      input.workspaceId,
      input.credentialId,
      input.credentialVersion,
      encryptedSession,
    );
    if (!rotated) throw new Error('Fanvue upload session version changed');
    return true;
  });
}
