import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { createStandaloneApplication } from '../application/create-application.js';
import {
  loadRuntimeConfig,
  resolveHumanAuthMode,
  resolveXProviderCredentials,
} from '../config/runtime-config.js';
import { RuntimeMasterKeyProvider } from '../config/runtime-master-keys.js';
import { createPostgresAuthStore } from '../modules/identity/auth.repository.js';
import { AuthService } from '../modules/identity/auth.service.js';
import { createPostgresMagicLinkStore } from '../modules/identity/magic-link.repository.js';
import { MagicLinkService } from '../modules/identity/magic-link.service.js';
import { AuthEmailOutboxDelivery } from '../modules/identity/auth-email-outbox.js';
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
const xCredentials = resolveXProviderCredentials(config);
const publicOrigin = config.PUBLISH_RELAY_PUBLIC_ORIGIN;
const magicLinkPepper = config.PUBLISH_RELAY_MAGIC_LINK_PEPPER;
const DEFAULT_STAGING_STALE_MS = 86_400_000;
if (!activeKeyVersion || !config.MEDIA_STORAGE_ROOT)
  throw new Error('Master key and media storage configuration are required for the web process');
if ((xCredentials || config.PUBLISH_RELAY_GOOGLE_CLIENT_ID) && !publicOrigin)
  throw new Error('PUBLISH_RELAY_PUBLIC_ORIGIN is required when OAuth providers are enabled');
const mediaStorage = new LocalMediaStorage(config.MEDIA_STORAGE_ROOT);
const masterKeys = new RuntimeMasterKeyProvider(activeKeyVersion);
await mediaStorage.cleanupStaleStaging({
  staleBefore: new Date(Date.now() - (config.MEDIA_STAGING_STALE_MS ?? DEFAULT_STAGING_STALE_MS)),
});
const application = createStandaloneApplication({
  config,
  auth: new AuthService(createPostgresAuthStore(database)),
  apiKeys: new ApiKeyService(createPostgresApiKeyStore(database)),
  database,
  ...(xCredentials && publicOrigin
    ? {
        xOauth: {
          keys: masterKeys,
          client: new XHttpClient(xCredentials),
          callbackUrl: new URL('/api/oauth/x/callback', publicOrigin).toString(),
        },
      }
    : {}),
  mediaStorage,
  ...(config.PUBLISH_RELAY_GOOGLE_CLIENT_ID &&
  config.PUBLISH_RELAY_GOOGLE_CLIENT_SECRET &&
  publicOrigin
    ? {
        youtubeOauth: {
          keys: masterKeys,
          client: new YouTubeHttpClient({
            clientId: config.PUBLISH_RELAY_GOOGLE_CLIENT_ID,
            clientSecret: config.PUBLISH_RELAY_GOOGLE_CLIENT_SECRET,
          }),
          callbackUrl: new URL('/api/oauth/youtube/callback', publicOrigin).toString(),
        },
      }
    : {}),
  delegatedAuthorization: new DelegatedAuthorizationService(
    createPostgresDelegatedAuthorizationStore(database),
  ),
  ...(resolveHumanAuthMode(config) === 'magic_link' && magicLinkPepper && publicOrigin
    ? {
        magicLinks: new MagicLinkService(
          createPostgresMagicLinkStore(database),
          new AuthEmailOutboxDelivery(database, masterKeys),
          {
            pepper: magicLinkPepper,
            publicOrigin,
            exposeDevelopmentUrl: config.NODE_ENV !== 'production',
          },
        ),
      }
    : {}),
});
application.addHook('onClose', async () => pool.end());

await application.listen({ host: config.HOST, port: config.PORT });
