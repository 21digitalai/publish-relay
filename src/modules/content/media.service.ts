import { createHash, randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  listExpiredTemporaryMedia,
  markMediaDeleted,
  markMediaReady,
  reserveMedia,
} from './media.repository.js';
import type { MediaStorage } from './media-storage.js';

const MIME_SIGNATURES: readonly { mimeType: string; signature: readonly number[] }[] = [
  { mimeType: 'image/png', signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/jpeg', signature: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/gif', signature: [0x47, 0x49, 0x46, 0x38] },
  { mimeType: 'image/webp', signature: [0x52, 0x49, 0x46, 0x46] },
];

function detectMimeType(bytes: Buffer): string {
  const match = MIME_SIGNATURES.find(({ signature }) =>
    signature.every((value, index) => bytes[index] === value),
  );
  if (!match) throw new Error('Unsupported media content');
  if (match.mimeType === 'image/webp' && bytes.subarray(8, 12).toString('ascii') !== 'WEBP')
    throw new Error('Unsupported media content');
  return match.mimeType;
}

export async function storeMedia(
  database: NodePgDatabase,
  storage: MediaStorage,
  input: { workspaceId: string; userId: string; bytes: Buffer; maxBytes: number },
): Promise<{ mediaId: string; mimeType: string; sha256: string; byteSize: number }> {
  if (input.bytes.length === 0) throw new Error('Media content is empty');
  if (input.bytes.length > input.maxBytes)
    throw new Error('Media exceeds the configured size limit');
  const mediaId = randomUUID();
  const mimeType = detectMimeType(input.bytes);
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
    return { mediaId, mimeType, sha256, byteSize: input.bytes.length };
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

export async function storeMediaInTransaction(
  transaction: NodePgDatabase,
  storage: MediaStorage,
  input: { workspaceId: string; userId: string; bytes: Buffer; maxBytes: number },
): Promise<{ mediaId: string; mimeType: string; sha256: string; byteSize: number }> {
  if (input.bytes.length === 0) throw new Error('Media content is empty');
  if (input.bytes.length > input.maxBytes)
    throw new Error('Media exceeds the configured size limit');
  const mediaId = randomUUID();
  const mimeType = detectMimeType(input.bytes);
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const storageKey = `${input.workspaceId}/${mediaId}/${sha256}`;
  await reserveMedia(transaction, {
    id: mediaId,
    workspaceId: input.workspaceId,
    storageKey,
    sha256,
    mimeType,
    byteSize: input.bytes.length,
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
    return { mediaId, mimeType, sha256, byteSize: input.bytes.length };
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
