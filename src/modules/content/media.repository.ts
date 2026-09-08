import { and, eq, lt, notExists } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { mediaObjects, revisionMedia } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export async function getReadyMediaForDownload(
  database: NodePgDatabase,
  workspaceId: string,
  mediaId: string,
): Promise<{ storageKey: string; mimeType: string; byteSize: number } | null> {
  return withTenantTransaction(database, { workspaceId }, async (transaction) => {
    const rows = await transaction
      .select({
        storageKey: mediaObjects.storageKey,
        mimeType: mediaObjects.mimeType,
        byteSize: mediaObjects.byteSize,
      })
      .from(mediaObjects)
      .where(
        and(
          eq(mediaObjects.workspaceId, workspaceId),
          eq(mediaObjects.id, mediaId),
          eq(mediaObjects.state, 'ready'),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function reserveMedia(
  database: NodePgDatabase,
  input: {
    id: string;
    workspaceId: string;
    storageKey: string;
    sha256: string;
    mimeType: string;
    byteSize: number;
    metadata?: {
      durationMs: number;
      width: number;
      height: number;
      videoCodec: string;
      audioCodec: string | null;
      container: string;
    };
  },
): Promise<void> {
  await database.insert(mediaObjects).values({
    ...input,
    durationMs: input.metadata?.durationMs,
    width: input.metadata?.width,
    height: input.metadata?.height,
    videoCodec: input.metadata?.videoCodec,
    audioCodec: input.metadata?.audioCodec,
    container: input.metadata?.container,
  });
}

export async function markMediaReady(
  database: NodePgDatabase,
  workspaceId: string,
  mediaId: string,
): Promise<boolean> {
  const rows = await database
    .update(mediaObjects)
    .set({ state: 'ready', retainedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(mediaObjects.workspaceId, workspaceId),
        eq(mediaObjects.id, mediaId),
        eq(mediaObjects.state, 'temporary'),
      ),
    )
    .returning({ id: mediaObjects.id });
  return rows.length === 1;
}

export async function markMediaDeleted(
  database: NodePgDatabase,
  workspaceId: string,
  mediaId: string,
): Promise<void> {
  await database
    .update(mediaObjects)
    .set({ state: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(mediaObjects.workspaceId, workspaceId), eq(mediaObjects.id, mediaId)));
}

export async function claimUnattachedMediaForDeletion(
  database: NodePgDatabase,
  workspaceId: string,
  mediaId: string,
): Promise<{ storageKey: string } | null> {
  return withTenantTransaction(database, { workspaceId }, async (transaction) => {
    const rows = await transaction
      .update(mediaObjects)
      .set({ state: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(mediaObjects.workspaceId, workspaceId),
          eq(mediaObjects.id, mediaId),
          eq(mediaObjects.state, 'ready'),
          notExists(
            transaction
              .select({ mediaId: revisionMedia.mediaId })
              .from(revisionMedia)
              .where(
                and(eq(revisionMedia.workspaceId, workspaceId), eq(revisionMedia.mediaId, mediaId)),
              ),
          ),
        ),
      )
      .returning({ storageKey: mediaObjects.storageKey });
    return rows[0] ?? null;
  });
}

export async function listExpiredTemporaryMedia(
  database: NodePgDatabase,
  workspaceId: string,
  createdBefore: Date,
): Promise<{ id: string; storageKey: string }[]> {
  return database
    .select({ id: mediaObjects.id, storageKey: mediaObjects.storageKey })
    .from(mediaObjects)
    .where(
      and(
        eq(mediaObjects.workspaceId, workspaceId),
        eq(mediaObjects.state, 'temporary'),
        lt(mediaObjects.createdAt, createdBefore),
      ),
    );
}
