import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { loadRuntimeConfig, resolveWorkerDatabaseUrl } from '../config/runtime-config.js';
import { resolveWorkerSecurityRuntime } from '../config/runtime-master-keys.js';
import { LocalMediaStorage } from '../modules/content/local-media-storage.js';
import {
  createFixedMediaRetentionPolicy,
  retainForeverMediaPolicy,
} from '../modules/content/media-retention.service.js';
import { runMediaRetentionCycle } from '../modules/content/media-retention.worker.js';
import { createMediaStagingReconciler } from '../modules/content/media-staging.worker.js';
import {
  createLocalXMediaSource,
  createXMediaClientFactory,
  dispatchDueXJobs,
  reconcileXJobs,
} from '../modules/providers/x-media-dispatch.service.js';

const config = loadRuntimeConfig();
const shutdownController = new AbortController();
const workerDatabaseUrl = resolveWorkerDatabaseUrl(config);
const { keys, xCredentials } = resolveWorkerSecurityRuntime(config);
const DEFAULT_STAGING_STALE_MS = 86_400_000;
const STAGING_RECONCILIATION_INTERVAL_MS = 60_000;
if (!config.MEDIA_STORAGE_ROOT || !config.PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION)
  throw new Error('Media storage and master key configuration are required for the worker');
const pool = new pg.Pool({
  connectionString: workerDatabaseUrl,
  options: '-c role=publish_relay_worker',
});
const database = drizzle(pool);
const mediaStorage = new LocalMediaStorage(config.MEDIA_STORAGE_ROOT);
const stagingStaleMs = config.MEDIA_STAGING_STALE_MS ?? DEFAULT_STAGING_STALE_MS;
const reconcileMediaStaging = createMediaStagingReconciler(mediaStorage, {
  staleMs: stagingStaleMs,
  intervalMs: STAGING_RECONCILIATION_INTERVAL_MS,
});
const mediaRetentionPolicy =
  config.MEDIA_RETENTION_DAYS === undefined
    ? retainForeverMediaPolicy
    : createFixedMediaRetentionPolicy(config.MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000);
let nextMediaRetentionAt = 0;
const xRuntime = xCredentials
  ? {
      database,
      keys,
      source: createLocalXMediaSource(database, config.MEDIA_STORAGE_ROOT),
      createClient: createXMediaClientFactory({
        consumerKey: xCredentials.consumerKey,
        consumerSecret: xCredentials.consumerSecret,
      }),
      workerId: config.WORKER_ID ?? 'publish-relay-worker',
      leaseMs: Math.max(config.WORKER_POLL_INTERVAL_MS * 10, 30_000),
    }
  : null;
if (!xRuntime)
  process.stdout.write(
    `${JSON.stringify({ event: 'provider_disabled', provider: 'x', reason: 'missing_configuration' })}\n`,
  );

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shutdownController.abort();
  });
}

while (!shutdownController.signal.aborted) {
  if (xRuntime) {
    await reconcileXJobs(xRuntime);
    await dispatchDueXJobs(xRuntime);
  }
  const now = new Date();
  const deletedStagingObjects = await reconcileMediaStaging(now);
  if (deletedStagingObjects !== undefined) {
    process.stdout.write(
      `${JSON.stringify({ event: 'media_staging_reconciliation', deleted: deletedStagingObjects })}\n`,
    );
  }
  if (now.getTime() >= nextMediaRetentionAt) {
    const retention = await runMediaRetentionCycle(database, mediaStorage, mediaRetentionPolicy, {
      batchSize: config.MEDIA_RETENTION_BATCH_SIZE ?? 100,
      retryDelayMs: config.MEDIA_RETENTION_RETRY_DELAY_MS ?? 300_000,
      staleClaimMs: config.MEDIA_RETENTION_STALE_CLAIM_MS ?? 900_000,
    });
    process.stdout.write(`${JSON.stringify({ event: 'media_retention_cycle', ...retention })}\n`);
    nextMediaRetentionAt = now.getTime() + (config.MEDIA_RETENTION_CLEANUP_INTERVAL_MS ?? 60_000);
  }
  await new Promise<void>((resolve) => setTimeout(resolve, config.WORKER_POLL_INTERVAL_MS));
}
await pool.end();
