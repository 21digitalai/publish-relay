import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerStagingArtifacts, publicationJobs } from '../../database/schema.js';

export async function retireExpiredUnattemptedStagingArtifact(
  database: NodePgDatabase,
  input: { workspaceId: string; jobId: string; artifactId: string; now: Date; leaseOwner?: string },
): Promise<boolean> {
  const rows = await database
    .update(providerStagingArtifacts)
    .set({ deletedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(providerStagingArtifacts.workspaceId, input.workspaceId),
        eq(providerStagingArtifacts.jobId, input.jobId),
        eq(providerStagingArtifacts.id, input.artifactId),
        isNull(providerStagingArtifacts.deletedAt),
        lt(providerStagingArtifacts.expiresAt, input.now),
        sql`EXISTS (SELECT 1 FROM publication_jobs job WHERE job.id = ${input.jobId} AND job.workspace_id = ${input.workspaceId} AND job.state = 'leased' AND (${input.leaseOwner ?? null}::text IS NULL OR job.lease_owner = ${input.leaseOwner ?? null}))`,
        sql`NOT EXISTS (SELECT 1 FROM publication_attempts attempt WHERE attempt.job_id = ${input.jobId} AND attempt.workspace_id = ${input.workspaceId})`,
      ),
    )
    .returning({ id: providerStagingArtifacts.id });
  return rows.length > 0;
}

export async function isUnattemptedLeasedJob(
  database: NodePgDatabase,
  input: { workspaceId: string; jobId: string; leaseOwner?: string },
): Promise<boolean> {
  const rows = await database
    .select({ id: publicationJobs.id })
    .from(publicationJobs)
    .where(
      and(
        eq(publicationJobs.workspaceId, input.workspaceId),
        eq(publicationJobs.id, input.jobId),
        eq(publicationJobs.state, 'leased'),
        ...(input.leaseOwner ? [eq(publicationJobs.leaseOwner, input.leaseOwner)] : []),
        sql`NOT EXISTS (SELECT 1 FROM publication_attempts attempt WHERE attempt.job_id = ${input.jobId} AND attempt.workspace_id = ${input.workspaceId})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

const TERMINAL_JOB_STATES = ['published', 'failed', 'cancelled', 'superseded'] as const;

export async function findStagingArtifact(
  database: NodePgDatabase,
  workspaceId: string,
  jobId: string,
  mediaId: string,
): Promise<{
  id: string;
  providerReference: string;
  providerReferenceCredentialId: string | null;
  uploadPhase: string;
  nextSegment: number;
  nextByteOffset: number;
  externalObjectId: string | null;
  expiresAt: Date;
} | null> {
  const rows = await database
    .select({
      id: providerStagingArtifacts.id,
      providerReference: providerStagingArtifacts.providerReference,
      providerReferenceCredentialId: providerStagingArtifacts.providerReferenceCredentialId,
      uploadPhase: providerStagingArtifacts.uploadPhase,
      nextSegment: providerStagingArtifacts.nextSegment,
      nextByteOffset: providerStagingArtifacts.nextByteOffset,
      externalObjectId: providerStagingArtifacts.externalObjectId,
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
    providerReferenceCredentialId?: string;
    expiresAt: Date;
  },
): Promise<{
  isOwner: boolean;
  id: string;
  providerReference: string;
  providerReferenceCredentialId: string | null;
  uploadPhase: string;
  nextSegment: number;
  nextByteOffset: number;
  externalObjectId: string | null;
}> {
  const inserted = await database
    .insert(providerStagingArtifacts)
    .values(input)
    .onConflictDoNothing()
    .returning({
      id: providerStagingArtifacts.id,
      providerReference: providerStagingArtifacts.providerReference,
      providerReferenceCredentialId: providerStagingArtifacts.providerReferenceCredentialId,
      uploadPhase: providerStagingArtifacts.uploadPhase,
      nextSegment: providerStagingArtifacts.nextSegment,
      nextByteOffset: providerStagingArtifacts.nextByteOffset,
      externalObjectId: providerStagingArtifacts.externalObjectId,
    });
  if (inserted[0]) return { isOwner: true, ...inserted[0] };
  const existing = await findStagingArtifact(
    database,
    input.workspaceId,
    input.jobId,
    input.mediaId,
  );
  if (!existing) throw new Error('X media staging reservation conflict could not be reconciled');
  return { isOwner: false, ...existing };
}

export async function updateStagingUploadProgress(
  database: NodePgDatabase,
  workspaceId: string,
  artifactId: string,
  progress: { uploadPhase: 'appending' | 'appended' | 'finalized'; nextSegment: number },
): Promise<void> {
  await database
    .update(providerStagingArtifacts)
    .set({ ...progress, updatedAt: new Date() })
    .where(
      and(
        eq(providerStagingArtifacts.workspaceId, workspaceId),
        eq(providerStagingArtifacts.id, artifactId),
        isNull(providerStagingArtifacts.deletedAt),
      ),
    );
}

export async function getStagingArtifactById(
  database: NodePgDatabase,
  workspaceId: string,
  artifactId: string,
): Promise<{
  id: string;
  providerReference: string;
  providerReferenceCredentialId: string | null;
  uploadPhase: string;
  nextSegment: number;
  nextByteOffset: number;
  externalObjectId: string | null;
} | null> {
  const rows = await database
    .select({
      id: providerStagingArtifacts.id,
      providerReference: providerStagingArtifacts.providerReference,
      providerReferenceCredentialId: providerStagingArtifacts.providerReferenceCredentialId,
      uploadPhase: providerStagingArtifacts.uploadPhase,
      nextSegment: providerStagingArtifacts.nextSegment,
      nextByteOffset: providerStagingArtifacts.nextByteOffset,
      externalObjectId: providerStagingArtifacts.externalObjectId,
    })
    .from(providerStagingArtifacts)
    .where(
      and(
        eq(providerStagingArtifacts.workspaceId, workspaceId),
        eq(providerStagingArtifacts.id, artifactId),
        isNull(providerStagingArtifacts.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
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

export async function updateStagingByteProgress(
  database: NodePgDatabase,
  workspaceId: string,
  artifactId: string,
  progress: {
    uploadPhase: 'initialized' | 'uploading' | 'finalized';
    nextByteOffset: number;
    externalObjectId?: string;
  },
): Promise<void> {
  await database
    .update(providerStagingArtifacts)
    .set({
      uploadPhase: progress.uploadPhase,
      nextByteOffset: progress.nextByteOffset,
      ...(progress.externalObjectId === undefined
        ? {}
        : { externalObjectId: progress.externalObjectId }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(providerStagingArtifacts.workspaceId, workspaceId),
        eq(providerStagingArtifacts.id, artifactId),
        isNull(providerStagingArtifacts.deletedAt),
      ),
    );
}

export async function attachStagingReferenceCredential(
  database: NodePgDatabase,
  workspaceId: string,
  artifactId: string,
  credentialId: string,
): Promise<void> {
  await database
    .update(providerStagingArtifacts)
    .set({ providerReferenceCredentialId: credentialId, updatedAt: new Date() })
    .where(
      and(
        eq(providerStagingArtifacts.workspaceId, workspaceId),
        eq(providerStagingArtifacts.id, artifactId),
        isNull(providerStagingArtifacts.deletedAt),
      ),
    );
}
