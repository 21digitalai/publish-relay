import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import type { RuntimeConfig } from '../config/runtime-config.js';
import {
  isAdapterEnabled,
  resolveHumanAuthMode,
  resolveTikTokProviderConfig,
  resolveXProviderCredentials,
} from '../config/runtime-config.js';
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
import {
  MetaHttpClient,
  parseMetaFamilyPermissions,
} from '../modules/providers/meta-http-client.js';
import { InstagramLoginClient } from '../modules/providers/instagram-login-client.js';
import { FacebookHttpClient } from '../modules/providers/facebook-http-client.js';
import { TikTokHttpClient } from '../modules/providers/tiktok-http-client.js';
import { FanvueHttpClient } from '../modules/providers/fanvue-http-client.js';
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

  const xCredentials = isAdapterEnabled(config, 'x') ? resolveXProviderCredentials(config) : null;
  const tiktokCredentials = isAdapterEnabled(config, 'tiktok')
    ? resolveTikTokProviderConfig(config)
    : null;
  const publicOrigin = config.PUBLISH_RELAY_PUBLIC_ORIGIN;
  if (
    (xCredentials ||
      (isAdapterEnabled(config, 'youtube') && config.PUBLISH_RELAY_GOOGLE_CLIENT_ID) ||
      (isAdapterEnabled(config, 'linkedin') && config.PUBLISH_RELAY_LINKEDIN_CLIENT_ID) ||
      (isAdapterEnabled(config, 'facebook_page') && config.PUBLISH_RELAY_META_APP_ID)) &&
    !publicOrigin
  )
    throw new Error('PUBLISH_RELAY_PUBLIC_ORIGIN is required when OAuth providers are enabled');
  if (
    isAdapterEnabled(config, 'instagram') &&
    config.PUBLISH_RELAY_INSTAGRAM_APP_ID &&
    !publicOrigin
  )
    throw new Error('PUBLISH_RELAY_PUBLIC_ORIGIN is required for Instagram Login');
  if (isAdapterEnabled(config, 'fanvue') && config.PUBLISH_RELAY_FANVUE_CLIENT_ID && !publicOrigin)
    throw new Error('PUBLISH_RELAY_PUBLIC_ORIGIN is required for Fanvue OAuth');
  if (
    isAdapterEnabled(config, 'linkedin') &&
    Boolean(config.PUBLISH_RELAY_LINKEDIN_CLIENT_ID) !==
      Boolean(config.PUBLISH_RELAY_LINKEDIN_CLIENT_SECRET)
  )
    throw new Error('LinkedIn OAuth requires both client ID and secret');
  if (
    isAdapterEnabled(config, 'facebook_page') &&
    Boolean(config.PUBLISH_RELAY_META_APP_ID) !== Boolean(config.PUBLISH_RELAY_META_APP_SECRET)
  )
    throw new Error('Meta OAuth requires both app ID and secret');
  if (
    isAdapterEnabled(config, 'facebook_page') &&
    config.PUBLISH_RELAY_META_APP_ID &&
    !config.PUBLISH_RELAY_META_GRAPH_VERSION
  )
    throw new Error('Meta OAuth requires a pinned Graph version');
  if (
    isAdapterEnabled(config, 'instagram') &&
    Boolean(config.PUBLISH_RELAY_INSTAGRAM_APP_ID) !==
      Boolean(config.PUBLISH_RELAY_INSTAGRAM_APP_SECRET)
  )
    throw new Error('Instagram Login requires its own app ID and secret');

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
      ...(isAdapterEnabled(config, 'youtube') &&
      config.PUBLISH_RELAY_GOOGLE_CLIENT_ID &&
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
      ...(isAdapterEnabled(config, 'linkedin') &&
      config.PUBLISH_RELAY_LINKEDIN_CLIENT_ID &&
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
      ...(isAdapterEnabled(config, 'facebook_page') &&
      config.PUBLISH_RELAY_META_APP_ID &&
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
              }),
              callbackUrl: new URL('/api/oauth/meta/callback', publicOrigin).toString(),
              familyPermissions: {
                ...(config.PUBLISH_RELAY_META_FACEBOOK_PAGES_PERMISSIONS
                  ? {
                      facebook_pages: parseMetaFamilyPermissions(
                        'facebook_pages',
                        config.PUBLISH_RELAY_META_FACEBOOK_PAGES_PERMISSIONS,
                      ),
                    }
                  : {}),
              },
            },
          }
        : {}),
      ...(isAdapterEnabled(config, 'facebook_page') && config.PUBLISH_RELAY_META_GRAPH_VERSION
        ? {
            facebookRead: {
              keys: masterKeys,
              client: new FacebookHttpClient({
                graphVersion: config.PUBLISH_RELAY_META_GRAPH_VERSION,
              }),
            },
          }
        : {}),
      ...(isAdapterEnabled(config, 'instagram') &&
      config.PUBLISH_RELAY_INSTAGRAM_APP_ID &&
      config.PUBLISH_RELAY_INSTAGRAM_APP_SECRET &&
      config.PUBLISH_RELAY_META_GRAPH_VERSION &&
      publicOrigin
        ? {
            instagramOauth: {
              keys: masterKeys,
              client: new InstagramLoginClient({
                appId: config.PUBLISH_RELAY_INSTAGRAM_APP_ID,
                appSecret: config.PUBLISH_RELAY_INSTAGRAM_APP_SECRET,
                graphVersion: config.PUBLISH_RELAY_META_GRAPH_VERSION,
              }),
              callbackUrl: new URL('/api/oauth/instagram/callback', publicOrigin).toString(),
            },
          }
        : {}),
      ...(tiktokCredentials
        ? {
            tiktokOauth: {
              keys: masterKeys,
              client: new TikTokHttpClient(tiktokCredentials),
              callbackUrl: new URL(
                '/api/oauth/tiktok/callback',
                tiktokCredentials.publicOrigin,
              ).toString(),
            },
          }
        : {}),
      ...(isAdapterEnabled(config, 'fanvue') &&
      config.PUBLISH_RELAY_FANVUE_CLIENT_ID &&
      config.PUBLISH_RELAY_FANVUE_CLIENT_SECRET &&
      publicOrigin
        ? {
            fanvueOauth: {
              keys: masterKeys,
              client: new FanvueHttpClient({
                clientId: config.PUBLISH_RELAY_FANVUE_CLIENT_ID,
                clientSecret: config.PUBLISH_RELAY_FANVUE_CLIENT_SECRET,
              }),
              callbackUrl: new URL('/api/oauth/fanvue/callback', publicOrigin).toString(),
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
