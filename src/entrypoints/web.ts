import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { createApplication } from '../application/create-application.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { RuntimeMasterKeyProvider } from '../config/runtime-master-keys.js';
import { createPostgresAuthStore } from '../modules/identity/auth.repository.js';
import { AuthService } from '../modules/identity/auth.service.js';
import { createPostgresApiKeyStore } from '../modules/identity/api-key.repository.js';
import { ApiKeyService } from '../modules/identity/api-key.service.js';
import { XHttpClient } from '../modules/providers/x-http-client.js';
import { LocalMediaStorage } from '../modules/content/local-media-storage.js';
import { YouTubeHttpClient } from '../modules/providers/youtube-http-client.js';
import { DelegatedAuthorizationService } from '../modules/delegated-authorization/delegated-authorization.service.js';
import { createPostgresDelegatedAuthorizationStore } from '../modules/delegated-authorization/delegated-authorization.repository.js';

const config = loadRuntimeConfig();
if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required for the web process');
const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  options: '-c role=publish_relay_web',
});
const database = drizzle(pool);
const activeKeyVersion = config.PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION;
const xConsumerKey = config.PUBLISH_RELAY_X_CONSUMER_KEY ?? config.X_API_KEY;
const xConsumerSecret = config.PUBLISH_RELAY_X_CONSUMER_SECRET ?? config.X_API_SECRET;
const publicOrigin = config.PUBLISH_RELAY_PUBLIC_ORIGIN;
const DEFAULT_STAGING_STALE_MS = 86_400_000;
if (
  !activeKeyVersion ||
  !xConsumerKey ||
  !xConsumerSecret ||
  !publicOrigin ||
  !config.MEDIA_STORAGE_ROOT
)
  throw new Error('X OAuth runtime configuration is required for the web process');
const mediaStorage = new LocalMediaStorage(config.MEDIA_STORAGE_ROOT);
await mediaStorage.cleanupStaleStaging({
  staleBefore: new Date(Date.now() - (config.MEDIA_STAGING_STALE_MS ?? DEFAULT_STAGING_STALE_MS)),
});
const application = createApplication(
  config,
  new AuthService(createPostgresAuthStore(database)),
  new ApiKeyService(createPostgresApiKeyStore(database)),
  undefined,
  database,
  {
    keys: new RuntimeMasterKeyProvider(activeKeyVersion),
    client: new XHttpClient({ consumerKey: xConsumerKey, consumerSecret: xConsumerSecret }),
    callbackUrl: new URL('/api/oauth/x/callback', publicOrigin).toString(),
  },
  mediaStorage,
  undefined,
  config.PUBLISH_RELAY_GOOGLE_CLIENT_ID && config.PUBLISH_RELAY_GOOGLE_CLIENT_SECRET
    ? {
        keys: new RuntimeMasterKeyProvider(activeKeyVersion),
        client: new YouTubeHttpClient({
          clientId: config.PUBLISH_RELAY_GOOGLE_CLIENT_ID,
          clientSecret: config.PUBLISH_RELAY_GOOGLE_CLIENT_SECRET,
        }),
        callbackUrl: new URL('/api/oauth/youtube/callback', publicOrigin).toString(),
      }
    : undefined,
  new DelegatedAuthorizationService(createPostgresDelegatedAuthorizationStore(database)),
);
application.addHook('onClose', async () => pool.end());

await application.listen({ host: config.HOST, port: config.PORT });
