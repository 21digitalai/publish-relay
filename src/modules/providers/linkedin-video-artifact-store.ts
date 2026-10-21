import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerStagingArtifacts, publicationJobs, revisionMedia } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export type LinkedInVideoPhase = 'reserved' | 'processing' | 'available' | 'failed';

interface LinkedInVideoArtifact {
  phase: LinkedInVideoPhase;
  video: string | null;
}

/** One durable provider asset per tenant-owned scheduled job and media object. */
export class PostgresLinkedInVideoArtifactStore {
  constructor(
    private readonly database: NodePgDatabase,
    private readonly scope: {
      workspaceId: string;
      jobId: string;
      mediaId: string;
      memberUrn: string;
      kind?: 'video' | 'image';
      now?: () => Date;
    },
  ) {}

  private get key(): string {
    return `linkedin:${this.scope.kind ?? 'video'}:${this.scope.mediaId}`;
  }

  private get artifactKind(): string {
    return `linkedin_${this.scope.kind ?? 'video'}`;
  }

  async ensure(): Promise<LinkedInVideoArtifact> {
    return withTenantTransaction(this.database, this.scope, async (tx) => {
      const now = this.scope.now?.() ?? new Date();
      const [attached] = await tx
        .select({ mediaId: revisionMedia.mediaId })
        .from(publicationJobs)
        .innerJoin(
          revisionMedia,
          and(
            eq(revisionMedia.workspaceId, publicationJobs.workspaceId),
            eq(revisionMedia.revisionId, publicationJobs.revisionId),
          ),
        )
        .where(
          and(
            eq(publicationJobs.workspaceId, this.scope.workspaceId),
            eq(publicationJobs.id, this.scope.jobId),
            eq(revisionMedia.mediaId, this.scope.mediaId),
          ),
        )
        .limit(1);
      if (!attached) throw new Error('LinkedIn video is not attached to this scheduled job');
      await tx
        .insert(providerStagingArtifacts)
        .values({
          workspaceId: this.scope.workspaceId,
          jobId: this.scope.jobId,
          mediaId: this.scope.mediaId,
          artifactKey: this.key,
          artifactKind: this.artifactKind,
          artifactStatus: 'reserved',
          providerReference: this.scope.memberUrn,
          expiresAt: new Date(
            now.getTime() +
              (this.scope.kind === 'image' ? 5 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000),
          ),
        })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(providerStagingArtifacts)
        .where(
          and(
            eq(providerStagingArtifacts.workspaceId, this.scope.workspaceId),
            eq(providerStagingArtifacts.jobId, this.scope.jobId),
            eq(providerStagingArtifacts.artifactKey, this.key),
          ),
        )
        .limit(1);
      if (
        row?.artifactKind !== this.artifactKind ||
        row.mediaId !== this.scope.mediaId ||
        row.providerReference !== this.scope.memberUrn ||
        row.deletedAt
      )
        throw new Error('LinkedIn video artifact identity mismatch');
      if (!['reserved', 'processing', 'available', 'failed'].includes(row.artifactStatus))
        throw new Error('LinkedIn video artifact phase is invalid');
      if (
        this.scope.kind === 'image' &&
        row.artifactStatus === 'processing' &&
        row.expiresAt <= now
      )
        throw new Error('LinkedIn image readiness timed out');
      return { phase: row.artifactStatus as LinkedInVideoPhase, video: row.externalObjectId };
    });
  }

  async recordUploaded(video: string): Promise<void> {
    if (!new RegExp(`^urn:li:${this.scope.kind ?? 'video'}:[^\\s]+$`).test(video))
      throw new Error('Invalid LinkedIn media URN');
    const rows = await withTenantTransaction(this.database, this.scope, (tx) =>
      tx
        .update(providerStagingArtifacts)
        .set({
          artifactStatus: 'processing',
          externalObjectId: video,
          updatedAt: this.scope.now?.() ?? new Date(),
        })
        .where(
          and(
            eq(providerStagingArtifacts.workspaceId, this.scope.workspaceId),
            eq(providerStagingArtifacts.jobId, this.scope.jobId),
            eq(providerStagingArtifacts.artifactKey, this.key),
            eq(providerStagingArtifacts.artifactKind, this.artifactKind),
            eq(providerStagingArtifacts.artifactStatus, 'reserved'),
            eq(providerStagingArtifacts.providerReference, this.scope.memberUrn),
          ),
        )
        .returning({ id: providerStagingArtifacts.id }),
    );
    if (rows.length !== 1) throw new Error('LinkedIn video upload state is not reserved');
  }

  async recordStatus(video: string, status: 'AVAILABLE' | 'PROCESSING_FAILED'): Promise<void> {
    const rows = await withTenantTransaction(this.database, this.scope, (tx) =>
      tx
        .update(providerStagingArtifacts)
        .set({
          artifactStatus: status === 'AVAILABLE' ? 'available' : 'failed',
          updatedAt: this.scope.now?.() ?? new Date(),
        })
        .where(
          and(
            eq(providerStagingArtifacts.workspaceId, this.scope.workspaceId),
            eq(providerStagingArtifacts.jobId, this.scope.jobId),
            eq(providerStagingArtifacts.artifactKey, this.key),
            eq(providerStagingArtifacts.artifactKind, this.artifactKind),
            eq(providerStagingArtifacts.artifactStatus, 'processing'),
            eq(providerStagingArtifacts.externalObjectId, video),
            eq(providerStagingArtifacts.providerReference, this.scope.memberUrn),
          ),
        )
        .returning({ id: providerStagingArtifacts.id }),
    );
    if (rows.length !== 1) throw new Error('LinkedIn video status transition is invalid');
  }
}
