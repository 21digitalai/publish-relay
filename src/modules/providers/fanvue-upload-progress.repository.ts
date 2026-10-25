import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerStagingArtifacts } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { getActiveCredential, rotateCredential } from '../credentials/credential.repository.js';
import {
  decryptCredential,
  encryptCredential,
  type MasterKeyProvider,
} from '../credentials/envelope.js';
import { fanvuePartRange } from './fanvue-media-upload-plan.js';
import {
  appendFanvuePartReceipt,
  parseFanvueUploadSession,
  type FanvueUploadSession,
} from './fanvue-upload-session.js';

interface FanvueUploadProgressInput {
  workspaceId: string;
  jobId: string;
  mediaId: string;
  artifactId: string;
  leaseOwner: string;
  credentialId: string;
  credentialVersion: number;
  session: FanvueUploadSession;
}

interface FanvuePartProgressInput extends FanvueUploadProgressInput {
  partNumber: number;
}

interface AdvanceFanvueUploadInput extends FanvuePartProgressInput {
  etag: string;
}

async function hasCurrentSession(
  transaction: NodePgDatabase,
  keys: MasterKeyProvider,
  input: FanvueUploadProgressInput,
  requireVersion: boolean,
): Promise<boolean> {
  const stored = await getActiveCredential(transaction, input.workspaceId, input.credentialId);
  if (!stored || (requireVersion && stored.version !== input.credentialVersion)) return false;
  const plaintext = await decryptCredential(stored, keys);
  try {
    const current = parseFanvueUploadSession(JSON.parse(plaintext.toString('utf8')) as unknown);
    return JSON.stringify(current) === JSON.stringify(parseFanvueUploadSession(input.session));
  } finally {
    plaintext.fill(0);
  }
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

function artifactAtProgress(
  input: FanvueUploadProgressInput,
  phase: string,
  expectedSegment: number,
  expectedByteOffset: number,
) {
  return and(
    eq(providerStagingArtifacts.workspaceId, input.workspaceId),
    eq(providerStagingArtifacts.jobId, input.jobId),
    eq(providerStagingArtifacts.mediaId, input.mediaId),
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

function eligibleArtifact(input: FanvuePartProgressInput, phase: string) {
  const { expectedSegment, expectedByteOffset } = expectedProgress(input);
  return artifactAtProgress(input, phase, expectedSegment, expectedByteOffset);
}

/** Persist possible signed PUT intent before sending bytes; pending is never auto-retried. */
export async function reserveFanvueUploadPart(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: FanvuePartProgressInput,
): Promise<boolean> {
  return withTenantTransaction(database, input, async (transaction) => {
    if (!(await hasCurrentSession(transaction, keys, input, true))) return false;
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
    if (!(await hasCurrentSession(transaction, keys, input, false))) return false;
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

/** Reserve the one provider completion PATCH after all part receipts are durable. */
export async function reserveFanvueUploadCompletion(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: FanvueUploadProgressInput,
): Promise<boolean> {
  const session = parseFanvueUploadSession(input.session);
  if (session.parts.length !== session.partCount)
    throw new Error('Fanvue upload parts are incomplete');
  return withTenantTransaction(database, input, async (transaction) => {
    if (!(await hasCurrentSession(transaction, keys, input, true))) return false;
    const [artifact] = await transaction
      .update(providerStagingArtifacts)
      .set({ uploadPhase: 'complete_pending', updatedAt: sql`clock_timestamp()` })
      .where(artifactAtProgress(input, 'uploading', session.partCount, session.byteSize))
      .returning({ id: providerStagingArtifacts.id });
    return Boolean(artifact);
  });
}

/** A lost completion response stays pending; only confirmed PATCH may advance. */
export async function confirmFanvueUploadCompletion(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: FanvueUploadProgressInput,
): Promise<boolean> {
  const session = parseFanvueUploadSession(input.session);
  if (session.parts.length !== session.partCount)
    throw new Error('Fanvue upload parts are incomplete');
  return withTenantTransaction(database, input, async (transaction) => {
    if (!(await hasCurrentSession(transaction, keys, input, true))) return false;
    const [artifact] = await transaction
      .update(providerStagingArtifacts)
      .set({
        uploadPhase: 'processing',
        externalObjectId: session.mediaUuid,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(artifactAtProgress(input, 'complete_pending', session.partCount, session.byteSize))
      .returning({ id: providerStagingArtifacts.id });
    return Boolean(artifact);
  });
}

/** Only the selected live Fanvue job may promote a provider-confirmed ready UUID. */
export async function markFanvueUploadReady(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    jobId: string;
    mediaId: string;
    artifactId: string;
    leaseOwner: string;
    mediaUuid: string;
  },
): Promise<boolean> {
  return withTenantTransaction(database, input, async (transaction) => {
    const [artifact] = await transaction
      .update(providerStagingArtifacts)
      .set({ uploadPhase: 'finalized', updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(providerStagingArtifacts.workspaceId, input.workspaceId),
          eq(providerStagingArtifacts.jobId, input.jobId),
          eq(providerStagingArtifacts.mediaId, input.mediaId),
          eq(providerStagingArtifacts.id, input.artifactId),
          eq(providerStagingArtifacts.providerReference, 'fanvue:multipart'),
          eq(providerStagingArtifacts.uploadPhase, 'processing'),
          eq(providerStagingArtifacts.externalObjectId, input.mediaUuid),
          gt(providerStagingArtifacts.expiresAt, sql`clock_timestamp()`),
          isNull(providerStagingArtifacts.deletedAt),
          sql`EXISTS (
          SELECT 1 FROM publication_jobs job
          JOIN provider_accounts account
            ON account.workspace_id = job.workspace_id AND account.id = job.provider_account_id
          WHERE job.workspace_id = ${input.workspaceId} AND job.id = ${input.jobId}
            AND job.state = 'leased' AND job.lease_owner = ${input.leaseOwner}
            AND job.lease_expires_at > clock_timestamp()
            AND account.destination_provider = 'fanvue'
            AND account.availability = 'active' AND account.disconnected_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM publication_attempts attempt
              WHERE attempt.workspace_id = job.workspace_id AND attempt.job_id = job.id
            )
        )`,
        ),
      )
      .returning({ id: providerStagingArtifacts.id });
    return Boolean(artifact);
  });
}

export async function getFanvueProcessingMediaUuid(
  database: NodePgDatabase,
  input: { workspaceId: string; jobId: string; mediaId: string; artifactId: string },
): Promise<string | null> {
  return withTenantTransaction(database, input, async (transaction) => {
    const [artifact] = await transaction
      .select({ mediaUuid: providerStagingArtifacts.externalObjectId })
      .from(providerStagingArtifacts)
      .where(
        and(
          eq(providerStagingArtifacts.workspaceId, input.workspaceId),
          eq(providerStagingArtifacts.jobId, input.jobId),
          eq(providerStagingArtifacts.mediaId, input.mediaId),
          eq(providerStagingArtifacts.id, input.artifactId),
          eq(providerStagingArtifacts.providerReference, 'fanvue:multipart'),
          eq(providerStagingArtifacts.uploadPhase, 'processing'),
          gt(providerStagingArtifacts.expiresAt, sql`clock_timestamp()`),
          isNull(providerStagingArtifacts.deletedAt),
        ),
      )
      .limit(1);
    return artifact?.mediaUuid ?? null;
  });
}
