import { createHash, randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  allowAllActionPolicy,
  enforceWorkspaceAction,
  type ActionPolicy,
} from '../policy/action-policy.js';
import {
  listExpiredTemporaryMedia,
  markMediaDeleted,
  markMediaReady,
  reserveMedia,
} from './media.repository.js';
import type { MediaStorage, StagedMedia } from './media-storage.js';
import type { MediaProbe, VideoMetadata } from './media-probe.js';

interface StoredMedia {
  mediaId: string;
  mimeType: string;
  sha256: string;
  byteSize: number;
  metadata?: VideoMetadata;
}

const MIME_SIGNATURES: readonly { mimeType: string; signature: readonly number[] }[] = [
  { mimeType: 'image/png', signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/jpeg', signature: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/gif', signature: [0x47, 0x49, 0x46, 0x38] },
  { mimeType: 'image/webp', signature: [0x52, 0x49, 0x46, 0x46] },
];

export function detectMimeType(bytes: Buffer): string {
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  const match = MIME_SIGNATURES.find(({ signature }) =>
    signature.every((value, index) => bytes[index] === value),
  );
  if (!match) throw new Error('Unsupported media content');
  if (match.mimeType === 'image/webp' && bytes.subarray(8, 12).toString('ascii') !== 'WEBP')
    throw new Error('Unsupported media content');
  return match.mimeType;
}

export async function storeStagedMediaInTransaction(
  transaction: NodePgDatabase,
  storage: MediaStorage,
  input: {
    workspaceId: string;
    userId: string;
    actor: { type: 'user' | 'api-key' | 'delegated'; id: string };
    requestId: string;
    idempotencyKey: string;
    staged: StagedMedia;
    mimeType: 'video/mp4' | 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    metadata?: VideoMetadata;
  },
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<StoredMedia> {
  if (!storage.promote) throw new Error('Streaming media storage is unavailable');
  await enforceWorkspaceAction(transaction, policy, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: 'media.ingest',
    request: {
      mediaBytes: input.staged.byteSize,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  const mediaId = randomUUID();
  const storageKey = `${input.workspaceId}/${mediaId}/${input.staged.sha256}`;
  await reserveMedia(transaction, {
    id: mediaId,
    workspaceId: input.workspaceId,
    storageKey,
    sha256: input.staged.sha256,
    mimeType: input.mimeType,
    byteSize: input.staged.byteSize,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  try {
    const stored = await storage.promote({
      staged: input.staged,
      workspaceId: input.workspaceId,
      mediaId,
    });
    if (stored.storageKey !== storageKey) throw new Error('Storage returned an unexpected key');
    const ready = await markMediaReady(transaction, input.workspaceId, mediaId);
    if (!ready) throw new Error('Reserved media record was not available for finalization');
    return {
      mediaId,
      mimeType: input.mimeType,
      sha256: input.staged.sha256,
      byteSize: input.staged.byteSize,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
  } catch (error) {
    await storage.delete(storageKey);
    throw error;
  }
}

export function validateMediaContentType(bytes: Buffer, declaredMimeType: string): void {
  const detectedMimeType = detectMimeType(bytes);
  if (detectedMimeType !== declaredMimeType)
    throw new Error(
      `Media Content-Type mismatch: declared ${declaredMimeType}, detected ${detectedMimeType}`,
    );
}

export async function storeMedia(
  database: NodePgDatabase,
  storage: MediaStorage,
  input: {
    workspaceId: string;
    userId: string;
    actor?: { type: 'user' | 'api-key' | 'delegated'; id: string };
    requestId?: string;
    idempotencyKey?: string;
    bytes: Buffer;
    maxBytes: number;
    probe?: MediaProbe;
    limits?: VideoLimits;
  },
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<StoredMedia> {
  if (input.bytes.length === 0) throw new Error('Media content is empty');
  if (input.bytes.length > input.maxBytes)
    throw new Error('Media exceeds the configured size limit');
  await withTenantTransaction(database, input, (transaction) =>
    enforceWorkspaceAction(transaction, policy, {
      workspaceId: input.workspaceId,
      actor: input.actor ?? { type: 'user', id: input.userId },
      action: 'media.ingest',
      request: {
        mediaBytes: input.bytes.length,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      },
    }),
  );
  const mediaId = randomUUID();
  const mimeType = detectMimeType(input.bytes);
  const metadata = await inspectVideo(mimeType, input.bytes, input.probe, input.limits);
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const storageKey = `${input.workspaceId}/${mediaId}/${sha256}`;
  await withTenantTransaction(database, input, (transaction) =>
    reserveMedia(transaction, {
      id: mediaId,
      workspaceId: input.workspaceId,
      storageKey,
      sha256,
      mimeType,
      byteSize: input.bytes.length,
      ...(metadata ? { metadata } : {}),
    }),
  );
  try {
    const stored = await storage.put({
      workspaceId: input.workspaceId,
      mediaId,
      bytes: input.bytes,
      mimeType,
    });
    if (stored.storageKey !== storageKey) throw new Error('Storage returned an unexpected key');
    const ready = await withTenantTransaction(database, input, (transaction) =>
      markMediaReady(transaction, input.workspaceId, mediaId),
    );
    if (!ready) throw new Error('Reserved media record was not available for finalization');
    return {
      mediaId,
      mimeType,
      sha256,
      byteSize: input.bytes.length,
      ...(metadata ? { metadata } : {}),
    };
  } catch (error) {
    try {
      await storage.delete(storageKey);
      await withTenantTransaction(database, input, (transaction) =>
        markMediaDeleted(transaction, input.workspaceId, mediaId),
      );
    } catch {
      // Keep the reservation temporary so reconciliation retains cleanup ownership.
    }
    throw error;
  }
}

async function persistMedia(
  transaction: NodePgDatabase,
  storage: MediaStorage,
  input: {
    workspaceId: string;
    userId: string;
    actor?: { type: 'user' | 'api-key' | 'delegated'; id: string };
    requestId?: string;
    idempotencyKey?: string;
    bytes: Buffer;
    maxBytes: number;
    probe?: MediaProbe;
    limits?: VideoLimits;
  },
): Promise<StoredMedia> {
  const mediaId = randomUUID();
  const mimeType = detectMimeType(input.bytes);
  const metadata = await inspectVideo(mimeType, input.bytes, input.probe, input.limits);
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const storageKey = `${input.workspaceId}/${mediaId}/${sha256}`;
  await reserveMedia(transaction, {
    id: mediaId,
    workspaceId: input.workspaceId,
    storageKey,
    sha256,
    mimeType,
    byteSize: input.bytes.length,
    ...(metadata ? { metadata } : {}),
  });
  try {
    const stored = await storage.put({
      workspaceId: input.workspaceId,
      mediaId,
      bytes: input.bytes,
      mimeType,
    });
    if (stored.storageKey !== storageKey) throw new Error('Storage returned an unexpected key');
    const ready = await markMediaReady(transaction, input.workspaceId, mediaId);
    if (!ready) throw new Error('Reserved media record was not available for finalization');
    return {
      mediaId,
      mimeType,
      sha256,
      byteSize: input.bytes.length,
      ...(metadata ? { metadata } : {}),
    };
  } catch (error) {
    try {
      await storage.delete(storageKey);
      await markMediaDeleted(transaction, input.workspaceId, mediaId);
    } catch {
      // Keep the reservation temporary so reconciliation retains cleanup ownership.
    }
    throw error;
  }
}

export async function storeMediaInTransaction(
  transaction: NodePgDatabase,
  storage: MediaStorage,
  input: {
    workspaceId: string;
    userId: string;
    actor?: { type: 'user' | 'api-key' | 'delegated'; id: string };
    requestId?: string;
    idempotencyKey?: string;
    bytes: Buffer;
    maxBytes: number;
    probe?: MediaProbe;
    limits?: VideoLimits;
  },
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<StoredMedia> {
  if (input.bytes.length === 0) throw new Error('Media content is empty');
  if (input.bytes.length > input.maxBytes)
    throw new Error('Media exceeds the configured size limit');
  await enforceWorkspaceAction(transaction, policy, {
    workspaceId: input.workspaceId,
    actor: input.actor ?? { type: 'user', id: input.userId },
    action: 'media.ingest',
    request: {
      mediaBytes: input.bytes.length,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    },
  });
  return persistMedia(transaction, storage, input);
}

export interface VideoLimits {
  maxDurationMs: number;
  maxWidth: number;
  maxHeight: number;
}

async function inspectVideo(
  mimeType: string,
  bytes: Buffer,
  probe?: MediaProbe,
  limits?: VideoLimits,
): Promise<VideoMetadata | undefined> {
  if (mimeType !== 'video/mp4') return undefined;
  if (!probe || !limits) throw new Error('MP4 probing is unavailable');
  const metadata = await probe.probeMp4(bytes);
  if (metadata.durationMs > limits.maxDurationMs)
    throw new Error('Media duration exceeds the configured limit');
  if (metadata.width > limits.maxWidth || metadata.height > limits.maxHeight)
    throw new Error('Media dimensions exceed the configured limit');
  return metadata;
}

export async function cleanupTemporaryMedia(
  database: NodePgDatabase,
  storage: MediaStorage,
  input: { workspaceId: string; olderThan: Date },
): Promise<number> {
  const stale = await withTenantTransaction(database, input, (transaction) =>
    listExpiredTemporaryMedia(transaction, input.workspaceId, input.olderThan),
  );
  let deleted = 0;
  for (const media of stale) {
    await storage.delete(media.storageKey);
    await withTenantTransaction(database, input, (transaction) =>
      markMediaDeleted(transaction, input.workspaceId, media.id),
    );
    deleted += 1;
  }
  return deleted;
}
