import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import type { RuntimeConfig } from '../config/runtime-config.js';
import { resolveHumanAuthMode, resolveXProviderCredentials } from '../config/runtime-config.js';
import { RuntimeMasterKeyProvider } from '../config/runtime-master-keys.js';
import { LocalMediaStorage } from '../modules/content/local-media-storage.js';
import { createPostgresDelegatedAuthorizationStore } from '../modules/delegated-authorization/delegated-authorization.repository.js';
import { DelegatedAuthorizationService } from '../modules/delegated-authorization/delegated-authorization.service.js';
import { createPostgresApiKeyStore } from '../modules/identity/api-key.repository.js';
import { ApiKeyService } from '../modules/identity/api-key.service.js';
import { createPostgresAuthStore } from '../modules/identity/auth.repository.js';
import { AuthService } from '../modules/identity/auth.service.js';
import { AuthEmailOutboxDelivery } from '../modules/identity/auth-email-outbox.js';
import { createPostgresMagicLinkStore } from '../modules/identity/magic-link.repository.js';
import { MagicLinkService } from '../modules/identity/magic-link.service.js';
import { XHttpClient } from '../modules/providers/x-http-client.js';
import { YouTubeHttpClient } from '../modules/providers/youtube-http-client.js';
import { LinkedInHttpClient } from '../modules/providers/linkedin-http-client.js';
import { MetaHttpClient, parseMetaPermissions } from '../modules/providers/meta-http-client.js';
import type { CoreApplicationOptions } from './create-application.js';

const DEFAULT_STAGING_STALE_MS = 86_400_000;

export interface CoreRuntime {
  options: CoreApplicationOptions;
  close(): Promise<void>;
}

export async function createCoreRuntime(config: RuntimeConfig): Promise<CoreRuntime> {
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required for the web process');
  const activeKeyVersion = config.PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION;
  if (!activeKeyVersion || !config.MEDIA_STORAGE_ROOT)
    throw new Error('Master key and media storage configuration are required for the web process');

  const xCredentials = resolveXProviderCredentials(config);
  const publicOrigin = config.PUBLISH_RELAY_PUBLIC_ORIGIN;
  if (
    (xCredentials ||
      config.PUBLISH_RELAY_GOOGLE_CLIENT_ID ||
      config.PUBLISH_RELAY_LINKEDIN_CLIENT_ID ||
      config.PUBLISH_RELAY_META_APP_ID) &&
    !publicOrigin
  )
    throw new Error('PUBLISH_RELAY_PUBLIC_ORIGIN is required when OAuth providers are enabled');
  if (
    Boolean(config.PUBLISH_RELAY_LINKEDIN_CLIENT_ID) !==
    Boolean(config.PUBLISH_RELAY_LINKEDIN_CLIENT_SECRET)
  )
    throw new Error('LinkedIn OAuth requires both client ID and secret');
  if (
    Boolean(config.PUBLISH_RELAY_META_APP_ID) !==
    Boolean(config.PUBLISH_RELAY_META_APP_SECRET)
  )
    throw new Error('Meta OAuth requires both app ID and secret');
  if (config.PUBLISH_RELAY_META_APP_ID && !config.PUBLISH_RELAY_META_GRAPH_VERSION)
    throw new Error('Meta OAuth requires a pinned Graph version');

  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    options: '-c role=publish_relay_web',
  });
  const database = drizzle(pool);
  const mediaStorage = new LocalMediaStorage(config.MEDIA_STORAGE_ROOT);
  const masterKeys = new RuntimeMasterKeyProvider(activeKeyVersion);
  await mediaStorage.cleanupStaleStaging({
    staleBefore: new Date(Date.now() - (config.MEDIA_STAGING_STALE_MS ?? DEFAULT_STAGING_STALE_MS)),
  });

  return {
    options: {
      config,
      auth: new AuthService(createPostgresAuthStore(database)),
      apiKeys: new ApiKeyService(createPostgresApiKeyStore(database)),
      database,
      mediaStorage,
      ...(xCredentials && publicOrigin
        ? {
            xOauth: {
              keys: masterKeys,
              client: new XHttpClient(xCredentials),
              callbackUrl: new URL('/api/oauth/x/callback', publicOrigin).toString(),
            },
          }
        : {}),
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
      ...(config.PUBLISH_RELAY_LINKEDIN_CLIENT_ID &&
      config.PUBLISH_RELAY_LINKEDIN_CLIENT_SECRET &&
      publicOrigin
        ? {
            linkedinOauth: {
              keys: masterKeys,
              client: new LinkedInHttpClient({
                clientId: config.PUBLISH_RELAY_LINKEDIN_CLIENT_ID,
                clientSecret: config.PUBLISH_RELAY_LINKEDIN_CLIENT_SECRET,
              }),
              callbackUrl: new URL('/api/oauth/linkedin/callback', publicOrigin).toString(),
            },
          }
        : {}),
      ...(config.PUBLISH_RELAY_META_APP_ID &&
      config.PUBLISH_RELAY_META_APP_SECRET &&
      config.PUBLISH_RELAY_META_GRAPH_VERSION &&
      publicOrigin
        ? {
            metaOauth: {
              keys: masterKeys,
              client: new MetaHttpClient({
                appId: config.PUBLISH_RELAY_META_APP_ID,
                appSecret: config.PUBLISH_RELAY_META_APP_SECRET,
                graphVersion: config.PUBLISH_RELAY_META_GRAPH_VERSION,
                permissions: parseMetaPermissions(config.PUBLISH_RELAY_META_PERMISSIONS),
              }),
              callbackUrl: new URL('/api/oauth/meta/callback', publicOrigin).toString(),
            },
          }
        : {}),
      delegatedAuthorization: new DelegatedAuthorizationService(
        createPostgresDelegatedAuthorizationStore(database),
      ),
      ...(resolveHumanAuthMode(config) === 'magic_link' &&
      config.PUBLISH_RELAY_MAGIC_LINK_PEPPER &&
      publicOrigin
        ? {
            magicLinks: new MagicLinkService(
              createPostgresMagicLinkStore(database),
              new AuthEmailOutboxDelivery(database, masterKeys),
              {
                pepper: config.PUBLISH_RELAY_MAGIC_LINK_PEPPER,
                publicOrigin,
                exposeDevelopmentUrl: config.NODE_ENV !== 'production',
              },
            ),
          }
        : {}),
    },
    close: async () => pool.end(),
  };
}
