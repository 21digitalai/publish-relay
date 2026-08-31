import { and, eq, lt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { mediaObjects } from '../../database/schema.js';

export async function reserveMedia(
  database: NodePgDatabase,
  input: {
    id: string;
    workspaceId: string;
    storageKey: string;
    sha256: string;
    mimeType: string;
    byteSize: number;
  },
): Promise<void> {
  await database.insert(mediaObjects).values(input);
}

export async function markMediaReady(
  database: NodePgDatabase,
  workspaceId: string,
  mediaId: string,
): Promise<boolean> {
  const rows = await database
    .update(mediaObjects)
    .set({ state: 'ready', updatedAt: new Date() })
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
    .set({ state: 'deleted', updatedAt: new Date() })
    .where(and(eq(mediaObjects.workspaceId, workspaceId), eq(mediaObjects.id, mediaId)));
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
