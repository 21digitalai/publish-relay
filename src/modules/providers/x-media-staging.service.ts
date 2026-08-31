import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  createStagingArtifact,
  findStagingArtifact,
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
  status(mediaId: string): Promise<{ state: 'succeeded' | 'pending' | 'failed' }>;
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
    const status = await client.status(existing.providerReference);
    if (status.state === 'failed') throw new Error('X media processing failed');
    if (status.state === 'succeeded') {
      return { mediaId: existing.providerReference, state: status.state };
    }
    const media = await source.load(input);
    validateXMedia(media);
    await appendAndFinalize(client, existing.providerReference, media.bytes);
    return { mediaId: existing.providerReference, state: 'pending' };
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
    const status = await client.status(artifact.providerReference);
    if (status.state === 'failed') throw new Error('X media processing failed');
    return { mediaId: artifact.providerReference, state: status.state };
  }
  return appendAndFinalize(client, initialized.mediaId, media.bytes);
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
  client: XMediaUploadClient,
  mediaId: string,
  bytes: Buffer,
): Promise<{ mediaId: string; state: 'succeeded' | 'pending' }> {
  for (let offset = 0, segment = 0; offset < bytes.length; offset += X_MEDIA_CHUNK_BYTES) {
    await client.append(mediaId, segment, bytes.subarray(offset, offset + X_MEDIA_CHUNK_BYTES));
    segment += 1;
  }
  const finalized = await client.finalize(mediaId);
  if (finalized.state === 'failed') throw new Error('X media processing failed');
  return { mediaId, state: finalized.state };
}
