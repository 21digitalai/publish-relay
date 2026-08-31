import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  createStagingArtifact,
  findStagingArtifact,
} from '../content/provider-staging.repository.js';

const X_MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;

export interface XMediaUploadClient {
  init(input: {
    totalBytes: number;
    mimeType: string;
    idempotencyKey: string;
  }): Promise<{ mediaId: string; expiresAfterSeconds: number }>;
  append(mediaId: string, segmentIndex: number, bytes: Buffer): Promise<void>;
  finalize(mediaId: string): Promise<{ state: 'succeeded' | 'pending' | 'failed' }>;
  status(mediaId: string): Promise<{ state: 'succeeded' | 'pending' | 'failed' }>;
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
    return { mediaId: existing.providerReference, state: status.state };
  }

  const media = await source.load(input);
  if (media.bytes.length === 0) throw new Error('X media content is empty');
  const initialized = await client.init({
    totalBytes: media.bytes.length,
    mimeType: media.mimeType,
    idempotencyKey: input.idempotencyKey,
  });
  const now = input.now ?? new Date();
  await withTenantTransaction(database, input, (transaction) =>
    createStagingArtifact(transaction, {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      mediaId: input.mediaId,
      providerReference: initialized.mediaId,
      expiresAt: new Date(now.getTime() + initialized.expiresAfterSeconds * 1000),
    }),
  );
  for (let offset = 0, segment = 0; offset < media.bytes.length; offset += X_MEDIA_CHUNK_BYTES) {
    await client.append(
      initialized.mediaId,
      segment,
      media.bytes.subarray(offset, offset + X_MEDIA_CHUNK_BYTES),
    );
    segment += 1;
  }
  const finalized = await client.finalize(initialized.mediaId);
  if (finalized.state === 'failed') throw new Error('X media processing failed');
  return { mediaId: initialized.mediaId, state: finalized.state };
}
