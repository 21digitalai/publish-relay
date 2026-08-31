import { and, eq, isNull, lt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerStagingArtifacts } from '../../database/schema.js';

export async function listJobStagingArtifacts(
  database: NodePgDatabase,
  workspaceId: string,
  jobId: string,
): Promise<{ id: string; providerReference: string }[]> {
  return database
    .select({
      id: providerStagingArtifacts.id,
      providerReference: providerStagingArtifacts.providerReference,
    })
    .from(providerStagingArtifacts)
    .where(
      and(
        eq(providerStagingArtifacts.workspaceId, workspaceId),
        eq(providerStagingArtifacts.jobId, jobId),
        isNull(providerStagingArtifacts.deletedAt),
      ),
    );
}

export async function listExpiredStagingArtifacts(
  database: NodePgDatabase,
  workspaceId: string,
  expiredBefore: Date,
): Promise<{ id: string; providerReference: string }[]> {
  return database
    .select({
      id: providerStagingArtifacts.id,
      providerReference: providerStagingArtifacts.providerReference,
    })
    .from(providerStagingArtifacts)
    .where(
      and(
        eq(providerStagingArtifacts.workspaceId, workspaceId),
        isNull(providerStagingArtifacts.deletedAt),
        lt(providerStagingArtifacts.expiresAt, expiredBefore),
      ),
    );
}

export async function markStagingArtifactDeleted(
  database: NodePgDatabase,
  workspaceId: string,
  artifactId: string,
  deletedAt: Date,
): Promise<void> {
  await database
    .update(providerStagingArtifacts)
    .set({ deletedAt, updatedAt: deletedAt })
    .where(
      and(
        eq(providerStagingArtifacts.workspaceId, workspaceId),
        eq(providerStagingArtifacts.id, artifactId),
        isNull(providerStagingArtifacts.deletedAt),
      ),
    );
}
