import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  createStagingArtifact,
  findStagingArtifact,
  getStagingArtifactById,
  updateStagingUploadProgress,
} from '../content/provider-staging.repository.js';

const X_MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;
const X_MEDIA_LIMITS: Readonly<Record<string, number>> = {
  'image/jpeg': 5 * 1024 * 1024,
  'image/png': 5 * 1024 * 1024,
  'image/webp': 5 * 1024 * 1024,
  'image/gif': 15 * 1024 * 1024,
  'video/mp4': 512 * 1024 * 1024,
};

export interface XMediaUploadClient {
  init(input: {
    totalBytes: number;
    mimeType: string;
    idempotencyKey: string;
  }): Promise<{ mediaId: string; expiresAfterSeconds: number }>;
  append(mediaId: string, segmentIndex: number, bytes: Buffer): Promise<void>;
  finalize(mediaId: string): Promise<{ state: 'succeeded' | 'pending' | 'failed' }>;
  status(mediaId: string): Promise<{ state: 'succeeded' | 'pending' | 'failed' | 'not_finalized' }>;
  discard(mediaId: string): Promise<void>;
}

export interface XMediaSource {
  load(input: { workspaceId: string; mediaId: string }): Promise<{
    bytes: Buffer;
    mimeType: string;
  }>;
}

export async function stageXMedia(
  database: NodePgDatabase,
  source: XMediaSource,
  client: XMediaUploadClient,
  input: {
    workspaceId: string;
    jobId: string;
    mediaId: string;
    idempotencyKey: string;
    now?: Date;
  },
): Promise<{ mediaId: string; state: 'succeeded' | 'pending' }> {
  const existing = await withTenantTransaction(database, input, (transaction) =>
    findStagingArtifact(transaction, input.workspaceId, input.jobId, input.mediaId),
  );
  if (existing) {
    return resumeStaging(database, source, client, input, existing);
  }

  const media = await source.load(input);
  validateXMedia(media);
  const initialized = await client.init({
    totalBytes: media.bytes.length,
    mimeType: media.mimeType,
    idempotencyKey: input.idempotencyKey,
  });
  const now = input.now ?? new Date();
  const artifact = await withTenantTransaction(database, input, (transaction) =>
    createStagingArtifact(transaction, {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      mediaId: input.mediaId,
      providerReference: initialized.mediaId,
      expiresAt: new Date(now.getTime() + initialized.expiresAfterSeconds * 1000),
    }),
  );
  if (!artifact.isOwner) {
    if (artifact.providerReference !== initialized.mediaId) {
      await client.discard(initialized.mediaId);
    }
    return resumeStaging(database, source, client, input, artifact);
  }
  return appendAndFinalize(database, client, input.workspaceId, artifact, media.bytes);
}

interface StagingProgress {
  id: string;
  providerReference: string;
  uploadPhase: string;
  nextSegment: number;
}

async function resumeStaging(
  database: NodePgDatabase,
  source: XMediaSource,
  client: XMediaUploadClient,
  input: { workspaceId: string; mediaId: string },
  artifact: StagingProgress,
): Promise<{ mediaId: string; state: 'succeeded' | 'pending' }> {
  if (artifact.uploadPhase === 'finalized') {
    const status = await client.status(artifact.providerReference);
    if (status.state === 'failed' || status.state === 'not_finalized') {
      throw new Error('X media processing failed');
    }
    return { mediaId: artifact.providerReference, state: status.state };
  }
  const media = await source.load(input);
  validateXMedia(media);
  return appendAndFinalize(database, client, input.workspaceId, artifact, media.bytes);
}

function validateXMedia(media: { bytes: Buffer; mimeType: string }): void {
  if (media.bytes.length === 0) throw new Error('X media content is empty');
  const maximumBytes = X_MEDIA_LIMITS[media.mimeType];
  if (!maximumBytes) throw new Error(`X media type ${media.mimeType} is unsupported`);
  if (media.bytes.length > maximumBytes) {
    throw new Error(`X media ${media.mimeType} exceeds the ${String(maximumBytes)}-byte limit`);
  }
}

async function appendAndFinalize(
  database: NodePgDatabase,
  client: XMediaUploadClient,
  workspaceId: string,
  artifact: StagingProgress,
  bytes: Buffer,
): Promise<{ mediaId: string; state: 'succeeded' | 'pending' }> {
  return withStagingLock(database, artifact.id, async () => {
    const current = await withTenantTransaction(database, { workspaceId }, (transaction) =>
      getStagingArtifactById(transaction, workspaceId, artifact.id),
    );
    // The advisory lock serializes provider transitions. Reload through the caller's
    // identity below because another owner may have advanced the cursor while waiting.
    const progress = current ?? artifact;
    let nextSegment = progress.nextSegment;
    if (progress.uploadPhase !== 'appended' && progress.uploadPhase !== 'finalized') {
      for (
        let offset = nextSegment * X_MEDIA_CHUNK_BYTES;
        offset < bytes.length;
        offset += X_MEDIA_CHUNK_BYTES
      ) {
        await client.append(
          artifact.providerReference,
          nextSegment,
          bytes.subarray(offset, offset + X_MEDIA_CHUNK_BYTES),
        );
        nextSegment += 1;
        await persistProgress(database, workspaceId, artifact.id, 'appending', nextSegment);
      }
      await persistProgress(database, workspaceId, artifact.id, 'appended', nextSegment);
    }
    if (progress.uploadPhase === 'finalized') {
      const status = await client.status(artifact.providerReference);
      if (status.state === 'failed' || status.state === 'not_finalized') {
        throw new Error('X media processing failed');
      }
      return { mediaId: artifact.providerReference, state: status.state };
    }
    const status = await client.status(artifact.providerReference);
    const finalized =
      status.state === 'not_finalized' ? await client.finalize(artifact.providerReference) : status;
    if (finalized.state === 'failed' || finalized.state === 'not_finalized') {
      throw new Error('X media processing failed');
    }
    await persistProgress(database, workspaceId, artifact.id, 'finalized', nextSegment);
    return { mediaId: artifact.providerReference, state: finalized.state };
  });
}

async function persistProgress(
  database: NodePgDatabase,
  workspaceId: string,
  artifactId: string,
  uploadPhase: 'appending' | 'appended' | 'finalized',
  nextSegment: number,
): Promise<void> {
  await withTenantTransaction(database, { workspaceId }, (transaction) =>
    updateStagingUploadProgress(transaction, workspaceId, artifactId, {
      uploadPhase,
      nextSegment,
    }),
  );
}

interface AdvisoryLockClient {
  query(text: string, values: unknown[]): Promise<unknown>;
  release(): void;
}

interface AdvisoryLockPool {
  connect?: () => Promise<AdvisoryLockClient>;
}

const localStagingLocks = new Map<string, Promise<void>>();

async function withStagingLock<T>(
  database: NodePgDatabase,
  artifactId: string,
  work: () => Promise<T>,
): Promise<T> {
  const pool = (database as NodePgDatabase & { $client: AdvisoryLockPool }).$client;
  if (!pool.connect) return withLocalStagingLock(artifactId, work);
  const connection = await pool.connect();
  await connection.query('SELECT pg_advisory_lock(hashtext($1))', [artifactId]);
  try {
    return await work();
  } finally {
    await connection.query('SELECT pg_advisory_unlock(hashtext($1))', [artifactId]);
    connection.release();
  }
}

async function withLocalStagingLock<T>(artifactId: string, work: () => Promise<T>): Promise<T> {
  const previous = localStagingLocks.get(artifactId) ?? Promise.resolve();
  let releaseLock = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const queued = previous.then(() => current);
  localStagingLocks.set(artifactId, queued);
  await previous;
  try {
    return await work();
  } finally {
    releaseLock();
    if (localStagingLocks.get(artifactId) === queued) localStagingLocks.delete(artifactId);
  }
}
