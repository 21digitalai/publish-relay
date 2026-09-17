import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerStagingArtifacts } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type {
  InstagramArtifact,
  InstagramArtifactKind,
  InstagramArtifactPhase,
  InstagramArtifactStore,
} from './instagram-adapter.js';
import type { InstagramErrorEvidence } from './instagram-http-client.js';

const DEFAULT_ARTIFACT_LIFETIME_MS = 24 * 60 * 60 * 1000;

function toArtifact(row: {
  artifactKey: string;
  artifactKind: string;
  artifactStatus: string;
  externalObjectId: string | null;
  redactedEvidence: unknown;
}): InstagramArtifact {
  return {
    key: row.artifactKey,
    kind: row.artifactKind as InstagramArtifactKind,
    phase: row.artifactStatus as InstagramArtifactPhase,
    ...(row.externalObjectId ? { externalObjectId: row.externalObjectId } : {}),
    ...(Object.keys(row.redactedEvidence ?? {}).length > 0
      ? { evidence: row.redactedEvidence as InstagramErrorEvidence }
      : {}),
  };
}

export class PostgresInstagramArtifactStore implements InstagramArtifactStore {
  public constructor(
    private readonly database: NodePgDatabase,
    private readonly scope: { workspaceId: string; jobId: string; now?: () => Date },
  ) {}

  public async ensure(input: { key: string; kind: InstagramArtifactKind; mediaId?: string }) {
    return withTenantTransaction(
      this.database,
      { workspaceId: this.scope.workspaceId },
      async (transaction) => {
        const now = this.scope.now?.() ?? new Date();
        await transaction
          .insert(providerStagingArtifacts)
          .values({
            workspaceId: this.scope.workspaceId,
            jobId: this.scope.jobId,
            ...(input.mediaId ? { mediaId: input.mediaId } : {}),
            artifactKey: input.key,
            artifactKind: input.kind,
            artifactStatus: 'initialized',
            providerReference: input.key,
            expiresAt: new Date(now.getTime() + DEFAULT_ARTIFACT_LIFETIME_MS),
          })
          .onConflictDoNothing();
        const [row] = await transaction
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
        if (row?.artifactKind !== input.kind) throw new Error('Instagram artifact conflict');
        return toArtifact(row);
      },
    );
  }

  public async update(
    key: string,
    update: {
      phase: InstagramArtifactPhase;
      externalObjectId?: string;
      evidence?: InstagramErrorEvidence;
    },
  ) {
    return withTenantTransaction(
      this.database,
      { workspaceId: this.scope.workspaceId },
      async (transaction) => {
        const [row] = await transaction
          .update(providerStagingArtifacts)
          .set({
            artifactStatus: update.phase,
            ...(update.externalObjectId === undefined
              ? {}
              : { externalObjectId: update.externalObjectId }),
            ...(update.evidence === undefined ? {} : { redactedEvidence: update.evidence }),
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
        if (!row) throw new Error('Instagram artifact is missing');
        return toArtifact(row);
      },
    );
  }
}
