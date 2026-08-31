import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  listExpiredStagingArtifacts,
  listJobStagingArtifacts,
  markStagingArtifactDeleted,
} from './provider-staging.repository.js';

export interface ProviderStagingStorage {
  delete(providerReference: string): Promise<void>;
}

async function deleteArtifacts(
  database: NodePgDatabase,
  storage: ProviderStagingStorage,
  workspaceId: string,
  artifacts: readonly { id: string; providerReference: string }[],
  now: Date,
): Promise<number> {
  let deleted = 0;
  for (const artifact of artifacts) {
    await storage.delete(artifact.providerReference);
    await withTenantTransaction(database, { workspaceId }, (transaction) =>
      markStagingArtifactDeleted(transaction, workspaceId, artifact.id, now),
    );
    deleted += 1;
  }
  return deleted;
}

export async function cleanupJobStaging(
  database: NodePgDatabase,
  storage: ProviderStagingStorage,
  input: { workspaceId: string; jobId: string; now?: Date },
): Promise<number> {
  const artifacts = await withTenantTransaction(database, input, (transaction) =>
    listJobStagingArtifacts(transaction, input.workspaceId, input.jobId),
  );
  return deleteArtifacts(database, storage, input.workspaceId, artifacts, input.now ?? new Date());
}

export async function cleanupExpiredStaging(
  database: NodePgDatabase,
  storage: ProviderStagingStorage,
  input: { workspaceId: string; expiredBefore: Date; now?: Date },
): Promise<number> {
  const artifacts = await withTenantTransaction(database, input, (transaction) =>
    listExpiredStagingArtifacts(transaction, input.workspaceId, input.expiredBefore),
  );
  return deleteArtifacts(database, storage, input.workspaceId, artifacts, input.now ?? new Date());
}
