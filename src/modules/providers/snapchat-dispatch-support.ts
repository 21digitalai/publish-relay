import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  mediaObjects,
  providerAccountExposures,
  providerAccounts,
  providerConnections,
  providerStagingArtifacts,
  publicationJobs,
  revisionMedia,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MediaStorage } from '../content/media-storage.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import type { SnapchatHttpClient } from './snapchat-http-client.js';
import type { SnapchatSpotlightClient } from './snapchat-spotlight-client.js';
import {
  snapchatSpotlightContentSchema,
  validateSnapchatSpotlightMedia,
} from './snapchat-spotlight-content.js';
import {
  snapchatStoryContentSchema,
  validateSnapchatStoryMedia,
} from './snapchat-story-content.js';

const MEDIA_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface SnapchatMediaRuntime {
  database: NodePgDatabase;
  keys: MasterKeyProvider;
  oauthClient: SnapchatHttpClient;
  client: SnapchatSpotlightClient;
  mediaStorage: MediaStorage;
  workerId: string;
  leaseMs: number;
}

export async function loadSnapchatJob(
  runtime: SnapchatMediaRuntime,
  workspaceId: string,
  jobId: string,
  kind: 'spotlight' | 'story' = 'spotlight',
) {
  return withTenantTransaction(runtime.database, { workspaceId }, async (tx) => {
    const rows = await tx
      .select({
        accountId: providerAccounts.id,
        profileId: providerAccounts.remoteAccountId,
        connectionProfileId: providerConnections.externalSubjectId,
        mediaId: mediaObjects.id,
        mimeType: mediaObjects.mimeType,
        byteSize: mediaObjects.byteSize,
        durationMs: mediaObjects.durationMs,
        width: mediaObjects.width,
        height: mediaObjects.height,
        storageKey: mediaObjects.storageKey,
        sha256: mediaObjects.sha256,
        content: publicationJobs.effectivePayload,
      })
      .from(publicationJobs)
      .innerJoin(
        providerAccounts,
        and(
          eq(providerAccounts.workspaceId, publicationJobs.workspaceId),
          eq(providerAccounts.id, publicationJobs.providerAccountId),
        ),
      )
      .innerJoin(
        providerConnections,
        and(
          eq(providerConnections.workspaceId, providerAccounts.workspaceId),
          eq(providerConnections.id, providerAccounts.connectionId),
        ),
      )
      .innerJoin(
        providerAccountExposures,
        and(
          eq(providerAccountExposures.workspaceId, publicationJobs.workspaceId),
          eq(providerAccountExposures.providerAccountId, providerAccounts.id),
          isNull(providerAccountExposures.revokedAt),
        ),
      )
      .innerJoin(
        revisionMedia,
        and(
          eq(revisionMedia.workspaceId, publicationJobs.workspaceId),
          eq(revisionMedia.revisionId, publicationJobs.revisionId),
        ),
      )
      .innerJoin(
        mediaObjects,
        and(
          eq(mediaObjects.workspaceId, revisionMedia.workspaceId),
          eq(mediaObjects.id, revisionMedia.mediaId),
        ),
      )
      .where(
        and(
          eq(publicationJobs.workspaceId, workspaceId),
          eq(publicationJobs.id, jobId),
          eq(providerAccounts.destinationProvider, 'snapchat'),
          eq(providerAccounts.availability, 'active'),
          isNull(providerAccounts.disconnectedAt),
          eq(providerConnections.provider, 'snapchat'),
          eq(providerConnections.status, 'active'),
          isNull(providerConnections.revokedAt),
          eq(mediaObjects.state, 'ready'),
          isNull(mediaObjects.deletedAt),
        ),
      )
      .limit(2);
    const row = rows[0];
    if (rows.length !== 1 || !row || row.profileId !== row.connectionProfileId)
      throw new Error('Snapchat owner profile or media is unavailable');
    if (kind === 'story') {
      const content = snapchatStoryContentSchema.parse(row.content);
      if (content.mediaId !== row.mediaId) throw new Error('Snapchat job media changed');
      validateSnapchatStoryMedia(content.kind, row);
      return { ...row, content };
    }
    const content = snapchatSpotlightContentSchema.parse(row.content);
    if (content.mediaId !== row.mediaId) throw new Error('Snapchat job media changed');
    validateSnapchatSpotlightMedia(row);
    return { ...row, content };
  });
}

export async function reserveSnapchatArtifact(
  runtime: SnapchatMediaRuntime,
  input: {
    workspaceId: string;
    jobId: string;
    attemptNumber: number;
    mediaId: string;
    now: Date;
    kind?: 'spotlight' | 'story';
  },
) {
  const kind = input.kind ?? 'spotlight';
  return withTenantTransaction(runtime.database, input, async (tx) => {
    if (input.attemptNumber > 1)
      await tx
        .update(providerStagingArtifacts)
        .set({ deletedAt: input.now, updatedAt: input.now })
        .where(
          and(
            eq(providerStagingArtifacts.workspaceId, input.workspaceId),
            eq(providerStagingArtifacts.jobId, input.jobId),
            eq(providerStagingArtifacts.mediaId, input.mediaId),
            eq(
              providerStagingArtifacts.artifactKey,
              `snapchat:${kind}:${String(input.attemptNumber - 1)}`,
            ),
            isNull(providerStagingArtifacts.deletedAt),
            isNull(providerStagingArtifacts.externalObjectId),
            sql`EXISTS (SELECT 1 FROM publication_attempts attempt
              WHERE attempt.workspace_id = ${input.workspaceId}
                AND attempt.job_id = ${input.jobId}
                AND attempt.attempt_number = ${input.attemptNumber - 1}
                AND attempt.outcome IN ('auth', 'rate_limit', 'validation', 'transient', 'permanent')
                AND attempt.reconciliation_key IS NULL)`,
          ),
        );
    const rows = await tx
      .insert(providerStagingArtifacts)
      .values({
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        mediaId: input.mediaId,
        artifactKey: `snapchat:${kind}:${String(input.attemptNumber)}`,
        artifactKind: `snapchat_${kind}`,
        providerReference: `snapchat:${kind}`,
        expiresAt: new Date(input.now.getTime() + MEDIA_LIFETIME_MS),
      })
      .onConflictDoNothing()
      .returning({ id: providerStagingArtifacts.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('Snapchat staging already exists; reconcile before retry');
    return id;
  });
}

export async function recordSnapchatArtifact(
  runtime: SnapchatMediaRuntime,
  workspaceId: string,
  artifactId: string,
  status: 'media' | 'posted',
  externalId: string,
) {
  await withTenantTransaction(runtime.database, { workspaceId }, async (tx) => {
    const rows = await tx
      .update(providerStagingArtifacts)
      .set({
        artifactStatus: status,
        externalObjectId: status === 'posted' ? externalId : null,
        ...(status === 'media' ? { redactedEvidence: { mediaId: externalId } } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(providerStagingArtifacts.workspaceId, workspaceId),
          eq(providerStagingArtifacts.id, artifactId),
        ),
      )
      .returning({ id: providerStagingArtifacts.id });
    if (!rows[0]) throw new Error('Snapchat staging artifact disappeared');
  });
}
