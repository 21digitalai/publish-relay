import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { loadRuntimeConfig } from '../config/runtime-config.js';
import { RuntimeMasterKeyProvider } from '../config/runtime-master-keys.js';
import {
  createLocalXMediaSource,
  createXMediaClientFactory,
  dispatchDueXMedia,
} from '../modules/providers/x-media-dispatch.service.js';

const config = loadRuntimeConfig();
const shutdownController = new AbortController();
if (
  !config.DATABASE_URL ||
  !config.MEDIA_STORAGE_ROOT ||
  !config.PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION ||
  !config.PUBLISH_RELAY_X_CONSUMER_KEY ||
  !config.PUBLISH_RELAY_X_CONSUMER_SECRET
)
  throw new Error(
    'Database, media storage, master key, and X runtime configuration are required for the worker',
  );
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const database = drizzle(pool);
const runtime = {
  database,
  keys: new RuntimeMasterKeyProvider(config.PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION),
  source: createLocalXMediaSource(database, config.MEDIA_STORAGE_ROOT),
  createClient: createXMediaClientFactory({
    consumerKey: config.PUBLISH_RELAY_X_CONSUMER_KEY,
    consumerSecret: config.PUBLISH_RELAY_X_CONSUMER_SECRET,
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
  await dispatchDueXMedia(runtime);
  await new Promise<void>((resolve) => setTimeout(resolve, config.WORKER_POLL_INTERVAL_MS));
}
await pool.end();
