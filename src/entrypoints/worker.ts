import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { loadRuntimeConfig, resolveWorkerDatabaseUrl } from '../config/runtime-config.js';
import { RuntimeMasterKeyProvider } from '../config/runtime-master-keys.js';
import {
  createLocalXMediaSource,
  createXMediaClientFactory,
  dispatchDueXJobs,
  reconcileXJobs,
} from '../modules/providers/x-media-dispatch.service.js';

const config = loadRuntimeConfig();
const shutdownController = new AbortController();
const workerDatabaseUrl = resolveWorkerDatabaseUrl(config);
const xConsumerKey = config.PUBLISH_RELAY_X_CONSUMER_KEY ?? config.X_API_KEY;
const xConsumerSecret = config.PUBLISH_RELAY_X_CONSUMER_SECRET ?? config.X_API_SECRET;
if (
  !config.MEDIA_STORAGE_ROOT ||
  !config.PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION ||
  !xConsumerKey ||
  !xConsumerSecret
)
  throw new Error(
    'Database, media storage, master key, and X runtime configuration are required for the worker',
  );
const pool = new pg.Pool({
  connectionString: workerDatabaseUrl,
  options: '-c role=publish_relay_worker',
});
const database = drizzle(pool);
const runtime = {
  database,
  keys: new RuntimeMasterKeyProvider(config.PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION),
  source: createLocalXMediaSource(database, config.MEDIA_STORAGE_ROOT),
  createClient: createXMediaClientFactory({
    consumerKey: xConsumerKey,
    consumerSecret: xConsumerSecret,
  }),
  workerId: config.WORKER_ID ?? 'publish-relay-worker',
  leaseMs: Math.max(config.WORKER_POLL_INTERVAL_MS * 10, 30_000),
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shutdownController.abort();
  });
}

while (!shutdownController.signal.aborted) {
  await reconcileXJobs(runtime);
  await dispatchDueXJobs(runtime);
  await new Promise<void>((resolve) => setTimeout(resolve, config.WORKER_POLL_INTERVAL_MS));
}
await pool.end();
