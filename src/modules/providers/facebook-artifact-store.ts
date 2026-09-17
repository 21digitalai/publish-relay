import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerStagingArtifacts } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type {
  FacebookArtifact,
  FacebookArtifactPhase,
  FacebookArtifactStore,
} from './facebook-adapter.js';
import type { FacebookErrorEvidence } from './facebook-http-client.js';

const ARTIFACT_LIFETIME_MS = 24 * 60 * 60 * 1000;

function toArtifact(row: {
  artifactKey: string;
  artifactStatus: string;
  externalObjectId: string | null;
  providerReference: string;
  redactedEvidence: unknown;
}): FacebookArtifact {
  const evidence = row.redactedEvidence as
    (FacebookErrorEvidence & { externalUrl?: string }) | null;
  return {
    key: row.artifactKey,
    phase: row.artifactStatus as FacebookArtifactPhase,
    ...(row.externalObjectId ? { externalObjectId: row.externalObjectId } : {}),
    ...(evidence?.externalUrl ? { externalUrl: evidence.externalUrl } : {}),
    ...(evidence && Object.keys(evidence).length > 0 ? { evidence } : {}),
  };
}

export class PostgresFacebookArtifactStore implements FacebookArtifactStore {
  public constructor(
    private readonly database: NodePgDatabase,
    private readonly scope: { workspaceId: string; jobId: string; now?: () => Date },
  ) {}

  public async ensure(input: { key: string; mediaId?: string }) {
    return withTenantTransaction(
      this.database,
      { workspaceId: this.scope.workspaceId },
      async (tx) => {
        const now = this.scope.now?.() ?? new Date();
        await tx
          .insert(providerStagingArtifacts)
          .values({
            workspaceId: this.scope.workspaceId,
            jobId: this.scope.jobId,
            ...(input.mediaId ? { mediaId: input.mediaId } : {}),
            artifactKey: input.key,
            artifactKind: 'fb_publish',
            artifactStatus: 'initialized',
            providerReference: input.key,
            expiresAt: new Date(now.getTime() + ARTIFACT_LIFETIME_MS),
          })
          .onConflictDoNothing();
        const [row] = await tx
          .select()
          .from(providerStagingArtifacts)
          .where(
            and(
              eq(providerStagingArtifacts.workspaceId, this.scope.workspaceId),
              eq(providerStagingArtifacts.jobId, this.scope.jobId),
              eq(providerStagingArtifacts.artifactKey, input.key),
            ),
          )
          .limit(1);
        if (row?.artifactKind !== 'fb_publish') throw new Error('Facebook artifact conflict');
        return toArtifact(row);
      },
    );
  }

  public async update(
    key: string,
    update: {
      phase: FacebookArtifactPhase;
      externalObjectId?: string;
      externalUrl?: string;
      evidence?: FacebookErrorEvidence;
    },
  ) {
    return withTenantTransaction(
      this.database,
      { workspaceId: this.scope.workspaceId },
      async (tx) => {
        const evidence = {
          ...(update.evidence ?? {}),
          ...(update.externalUrl ? { externalUrl: update.externalUrl } : {}),
        };
        const [row] = await tx
          .update(providerStagingArtifacts)
          .set({
            artifactStatus: update.phase,
            ...(update.externalObjectId ? { externalObjectId: update.externalObjectId } : {}),
            ...(Object.keys(evidence).length > 0 ? { redactedEvidence: evidence } : {}),
            updatedAt: this.scope.now?.() ?? new Date(),
          })
          .where(
            and(
              eq(providerStagingArtifacts.workspaceId, this.scope.workspaceId),
              eq(providerStagingArtifacts.jobId, this.scope.jobId),
              eq(providerStagingArtifacts.artifactKey, key),
            ),
          )
          .returning();
        if (!row) throw new Error('Facebook artifact is missing');
        return toArtifact(row);
      },
    );
  }
}
