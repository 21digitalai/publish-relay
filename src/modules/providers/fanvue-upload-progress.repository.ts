import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerStagingArtifacts } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { rotateCredential } from '../credentials/credential.repository.js';
import { encryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
import { fanvuePartRange } from './fanvue-media-upload-plan.js';
import {
  appendFanvuePartReceipt,
  parseFanvueUploadSession,
  type FanvueUploadSession,
} from './fanvue-upload-session.js';

interface FanvuePartProgressInput {
  workspaceId: string;
  jobId: string;
  artifactId: string;
  leaseOwner: string;
  credentialId: string;
  session: FanvueUploadSession;
  partNumber: number;
}

interface AdvanceFanvueUploadInput extends FanvuePartProgressInput {
  credentialVersion: number;
  etag: string;
}

function expectedProgress(input: FanvuePartProgressInput) {
  const session = parseFanvueUploadSession(input.session);
  if (input.partNumber !== session.parts.length + 1)
    throw new Error('Fanvue upload part is not next in sequence');
  fanvuePartRange(session, input.partNumber);
  const expectedSegment = input.partNumber - 1;
  const expectedByteOffset =
    expectedSegment === 0 ? 0 : fanvuePartRange(session, expectedSegment).end + 1;
  return { expectedSegment, expectedByteOffset };
}

function eligibleArtifact(input: FanvuePartProgressInput, phase: string) {
  const { expectedSegment, expectedByteOffset } = expectedProgress(input);
  return and(
    eq(providerStagingArtifacts.workspaceId, input.workspaceId),
    eq(providerStagingArtifacts.jobId, input.jobId),
    eq(providerStagingArtifacts.id, input.artifactId),
    eq(providerStagingArtifacts.providerReferenceCredentialId, input.credentialId),
    eq(providerStagingArtifacts.uploadPhase, phase),
    eq(providerStagingArtifacts.nextSegment, expectedSegment),
    eq(providerStagingArtifacts.nextByteOffset, expectedByteOffset),
    gt(providerStagingArtifacts.expiresAt, sql`clock_timestamp()`),
    isNull(providerStagingArtifacts.deletedAt),
    sql`EXISTS (
      SELECT 1 FROM publication_jobs job
      JOIN provider_accounts account
        ON account.workspace_id = job.workspace_id AND account.id = job.provider_account_id
      WHERE job.workspace_id = ${input.workspaceId}
        AND job.id = ${input.jobId}
        AND job.state = 'leased'
        AND job.lease_owner = ${input.leaseOwner}
        AND job.lease_expires_at > clock_timestamp()
        AND account.destination_provider = 'fanvue'
        AND account.availability = 'active'
        AND account.disconnected_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM publication_attempts attempt
          WHERE attempt.workspace_id = job.workspace_id AND attempt.job_id = job.id
        )
    )`,
  );
}

/** Persist possible signed PUT intent before sending bytes; pending is never auto-retried. */
export async function reserveFanvueUploadPart(
  database: NodePgDatabase,
  input: FanvuePartProgressInput,
): Promise<boolean> {
  return withTenantTransaction(database, input, async (transaction) => {
    const [artifact] = await transaction
      .update(providerStagingArtifacts)
      .set({ uploadPhase: 'put_pending', updatedAt: sql`clock_timestamp()` })
      .where(eligibleArtifact(input, 'uploading'))
      .returning({ id: providerStagingArtifacts.id });
    return Boolean(artifact);
  });
}

/** Commit an encrypted part receipt and its offset together, or preserve both old values. */
export async function advanceFanvueUploadProgress(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: AdvanceFanvueUploadInput,
): Promise<boolean> {
  const receipt = appendFanvuePartReceipt(input.session, input.partNumber, input.etag);
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
        uploadPhase: 'uploading',
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eligibleArtifact(input, 'put_pending'))
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
