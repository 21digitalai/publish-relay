import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { MediaStorage } from './media-storage.js';
import {
  cleanupRetainedMedia,
  evaluateMediaRetention,
  type MediaRetentionPolicy,
} from './media-retention.service.js';

export interface MediaRetentionWorkerConfig {
  batchSize: number;
  retryDelayMs: number;
  staleClaimMs: number;
}

export interface MediaRetentionCycleResult {
  workspaces: number;
  eligible: number;
  deleted: number;
  failed: number;
}

export async function runMediaRetentionCycle(
  database: NodePgDatabase,
  storage: MediaStorage,
  policy: MediaRetentionPolicy,
  config: MediaRetentionWorkerConfig,
  now = new Date(),
): Promise<MediaRetentionCycleResult> {
  const workspaces = await database.execute<{ id: string }>(sql`
    select id from workspaces order by id
  `);
  const result: MediaRetentionCycleResult = {
    workspaces: workspaces.rows.length,
    eligible: 0,
    deleted: 0,
    failed: 0,
  };
  for (const workspace of workspaces.rows) {
    result.eligible += await evaluateMediaRetention(database, {
      workspaceId: workspace.id,
      now,
      policy,
      limit: config.batchSize,
    });
    const cleanup = await cleanupRetainedMedia(database, storage, {
      workspaceId: workspace.id,
      now,
      retryDelayMs: config.retryDelayMs,
      staleClaimBefore: new Date(now.getTime() - config.staleClaimMs),
      limit: config.batchSize,
    });
    result.deleted += cleanup.deleted;
    result.failed += cleanup.failed;
  }
  return result;
}
