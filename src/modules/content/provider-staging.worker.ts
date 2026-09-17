import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { markExpiredInstagramStagingArtifacts } from './provider-staging.repository.js';

export interface ProviderStagingCleanupConfig {
  batchSize: number;
  terminalGraceMs: number;
}

export interface ProviderStagingCleanupResult {
  workspaces: number;
  instagramDeleted: number;
}

export async function runProviderStagingCleanupCycle(
  database: NodePgDatabase,
  config: ProviderStagingCleanupConfig,
  now = new Date(),
): Promise<ProviderStagingCleanupResult> {
  const workspaces = await database.execute<{ id: string }>(sql`
    select id from workspaces order by id
  `);
  const result: ProviderStagingCleanupResult = {
    workspaces: workspaces.rows.length,
    instagramDeleted: 0,
  };
  const terminalBefore = new Date(now.getTime() - config.terminalGraceMs);
  for (const workspace of workspaces.rows) {
    result.instagramDeleted += await withTenantTransaction(
      database,
      { workspaceId: workspace.id },
      (transaction) =>
        markExpiredInstagramStagingArtifacts(transaction, {
          workspaceId: workspace.id,
          expiredBefore: now,
          terminalBefore,
          deletedAt: now,
          limit: config.batchSize,
        }),
    );
  }
  return result;
}
