import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerStagingArtifacts } from '../../database/schema.js';
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
      now?: () => Date;
    },
  ) {}

  private get key(): string {
    return `linkedin:video:${this.scope.mediaId}`;
  }

  async ensure(): Promise<LinkedInVideoArtifact> {
    return withTenantTransaction(this.database, this.scope, async (tx) => {
      const now = this.scope.now?.() ?? new Date();
      await tx
        .insert(providerStagingArtifacts)
        .values({
          workspaceId: this.scope.workspaceId,
          jobId: this.scope.jobId,
          mediaId: this.scope.mediaId,
          artifactKey: this.key,
          artifactKind: 'linkedin_video',
          artifactStatus: 'reserved',
          providerReference: this.scope.memberUrn,
          expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
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
        row?.artifactKind !== 'linkedin_video' ||
        row.mediaId !== this.scope.mediaId ||
        row.providerReference !== this.scope.memberUrn ||
        row.deletedAt
      )
        throw new Error('LinkedIn video artifact identity mismatch');
      if (!['reserved', 'processing', 'available', 'failed'].includes(row.artifactStatus))
        throw new Error('LinkedIn video artifact phase is invalid');
      return { phase: row.artifactStatus as LinkedInVideoPhase, video: row.externalObjectId };
    });
  }

  async recordUploaded(video: string): Promise<void> {
    if (!/^urn:li:video:[^\s]+$/.test(video)) throw new Error('Invalid LinkedIn video URN');
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
            eq(providerStagingArtifacts.artifactKind, 'linkedin_video'),
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
            eq(providerStagingArtifacts.artifactKind, 'linkedin_video'),
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
