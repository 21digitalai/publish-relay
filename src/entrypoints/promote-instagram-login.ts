import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { z } from 'zod';

import { loadRuntimeConfig } from '../config/runtime-config.js';
import { RuntimeMasterKeyProvider } from '../config/runtime-master-keys.js';
import { InstagramLoginClient } from '../modules/providers/instagram-login-client.js';
import { promoteInstagramLoginAccount } from '../modules/providers/instagram-login-promotion.service.js';

const inputSchema = z.tuple([z.uuid(), z.uuid()]);
const [workspaceId, accountId] = inputSchema.parse(process.argv.slice(2));
const config = loadRuntimeConfig();
if (
  !config.DATABASE_URL ||
  !config.PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION ||
  !config.PUBLISH_RELAY_INSTAGRAM_APP_ID ||
  !config.PUBLISH_RELAY_INSTAGRAM_APP_SECRET ||
  !config.PUBLISH_RELAY_META_GRAPH_VERSION
)
  throw new Error('Instagram Login promotion runtime is not configured');

const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  options: '-c role=publish_relay_web',
});
try {
  const promoted = await promoteInstagramLoginAccount(
    drizzle(pool),
    new RuntimeMasterKeyProvider(config.PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION),
    new InstagramLoginClient({
      appId: config.PUBLISH_RELAY_INSTAGRAM_APP_ID,
      appSecret: config.PUBLISH_RELAY_INSTAGRAM_APP_SECRET,
      graphVersion: config.PUBLISH_RELAY_META_GRAPH_VERSION,
    }),
    { workspaceId, accountId, requestId: `instagram-login-promotion:${accountId}` },
  );
  process.stdout.write(
    promoted ? 'Instagram Login account promoted\n' : 'No matching eligible account promoted\n',
  );
  if (!promoted) process.exitCode = 1;
} finally {
  await pool.end();
}
