import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerStagingArtifacts, publicationJobs } from '../../database/schema.js';

const TERMINAL_JOB_STATES = ['published', 'failed', 'cancelled', 'superseded'] as const;

export async function findStagingArtifact(
  database: NodePgDatabase,
  workspaceId: string,
  jobId: string,
  mediaId: string,
): Promise<{ id: string; providerReference: string; expiresAt: Date } | null> {
  const rows = await database
    .select({
      id: providerStagingArtifacts.id,
      providerReference: providerStagingArtifacts.providerReference,
      expiresAt: providerStagingArtifacts.expiresAt,
    })
    .from(providerStagingArtifacts)
    .where(
      and(
        eq(providerStagingArtifacts.workspaceId, workspaceId),
        eq(providerStagingArtifacts.jobId, jobId),
        eq(providerStagingArtifacts.mediaId, mediaId),
        isNull(providerStagingArtifacts.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createStagingArtifact(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    jobId: string;
    mediaId: string;
    providerReference: string;
    expiresAt: Date;
  },
): Promise<void> {
  await database.insert(providerStagingArtifacts).values(input).onConflictDoNothing();
}

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
    .innerJoin(
      publicationJobs,
      and(
        eq(publicationJobs.workspaceId, providerStagingArtifacts.workspaceId),
        eq(publicationJobs.id, providerStagingArtifacts.jobId),
      ),
    )
    .where(
      and(
        eq(providerStagingArtifacts.workspaceId, workspaceId),
        eq(providerStagingArtifacts.jobId, jobId),
        isNull(providerStagingArtifacts.deletedAt),
        inArray(publicationJobs.state, TERMINAL_JOB_STATES),
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
