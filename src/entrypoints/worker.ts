import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import {
  loadRuntimeConfig,
  resolveHumanAuthMode,
  resolveTikTokProviderConfig,
  resolveWorkerDatabaseUrl,
} from '../config/runtime-config.js';
import { resolveWorkerSecurityRuntime } from '../config/runtime-master-keys.js';
import { LocalMediaStorage } from '../modules/content/local-media-storage.js';
import { dispatchAuthEmailOutbox } from '../modules/identity/auth-email-outbox.js';
import { ResendEmailDelivery } from '../modules/identity/resend-email.delivery.js';
import {
  createFixedMediaRetentionPolicy,
  retainForeverMediaPolicy,
} from '../modules/content/media-retention.service.js';
import { runMediaRetentionCycle } from '../modules/content/media-retention.worker.js';
import { createMediaStagingReconciler } from '../modules/content/media-staging.worker.js';
import { runProviderStagingCleanupCycle } from '../modules/content/provider-staging.worker.js';
import {
  runDestinationDispatchCycle,
  type DestinationDispatchAdapter,
} from '../modules/providers/destination-dispatch-runtime.js';
import {
  createLocalXMediaSource,
  createXMediaClientFactory,
  dispatchDueXJobs,
  reconcileXJobs,
} from '../modules/providers/x-media-dispatch.service.js';
import { YouTubeHttpClient } from '../modules/providers/youtube-http-client.js';
import { LinkedInHttpClient } from '../modules/providers/linkedin-http-client.js';
import { dispatchDueLinkedInJobs } from '../modules/providers/linkedin-dispatch.service.js';
import { InstagramHttpClient } from '../modules/providers/instagram-http-client.js';
import { InstagramLoginClient } from '../modules/providers/instagram-login-client.js';
import { InstagramMediaTokenCodec } from '../modules/providers/instagram-media-token.js';
import {
  dispatchDueInstagramJobs,
  reconcileInstagramJobs,
} from '../modules/providers/instagram-dispatch.service.js';
import {
  dispatchDueYouTubeJobs,
  reconcileYouTubeJobs,
} from '../modules/providers/youtube-media-dispatch.service.js';
import { FacebookHttpClient } from '../modules/providers/facebook-http-client.js';
import { dispatchDuePageDms } from '../modules/providers/facebook-dm-pending.worker.js';
import { FanvueHttpClient } from '../modules/providers/fanvue-http-client.js';
import { FanvueMediaUploadClient } from '../modules/providers/fanvue-media-upload-client.js';
import { FanvuePostClient } from '../modules/providers/fanvue-post-client.js';
import { dispatchDueFanvueJobs } from '../modules/providers/fanvue-post-dispatch.service.js';
import { TikTokHttpClient } from '../modules/providers/tiktok-http-client.js';
import { TikTokMediaGrantService } from '../modules/providers/tiktok-media-grant.service.js';
import { dispatchDueTikTokJobs } from '../modules/providers/tiktok-direct-post-dispatch.service.js';
import { reconcileTikTokDirectPosts } from '../modules/providers/tiktok-status-reconciliation.service.js';
import {
  dispatchDueFacebookJobs,
  reconcileFacebookJobs,
} from '../modules/providers/facebook-dispatch.service.js';

const config = loadRuntimeConfig();
const authEmailDelivery =
  resolveHumanAuthMode(config) === 'magic_link' &&
  config.PUBLISH_RELAY_RESEND_API_KEY &&
  config.PUBLISH_RELAY_AUTH_EMAIL_FROM
    ? new ResendEmailDelivery({
        apiKey: config.PUBLISH_RELAY_RESEND_API_KEY,
        from: config.PUBLISH_RELAY_AUTH_EMAIL_FROM,
      })
    : null;
const shutdownController = new AbortController();
const workerDatabaseUrl = resolveWorkerDatabaseUrl(config);
const { keys, xCredentials } = resolveWorkerSecurityRuntime(config);
const DEFAULT_STAGING_STALE_MS = 86_400_000;
const STAGING_RECONCILIATION_INTERVAL_MS = 60_000;
const PROVIDER_STAGING_TERMINAL_GRACE_MS = 24 * 60 * 60 * 1000;
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
        onPostDenial: (diagnostic) => {
          process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
        },
      }),
      workerId: config.WORKER_ID ?? 'publish-relay-worker',
      leaseMs: Math.max(config.WORKER_POLL_INTERVAL_MS * 10, 30_000),
    }
  : null;
const youtubeRuntime =
  config.PUBLISH_RELAY_GOOGLE_CLIENT_ID && config.PUBLISH_RELAY_GOOGLE_CLIENT_SECRET
    ? {
        database,
        keys,
        source: createLocalXMediaSource(database, config.MEDIA_STORAGE_ROOT),
        client: new YouTubeHttpClient({
          clientId: config.PUBLISH_RELAY_GOOGLE_CLIENT_ID,
          clientSecret: config.PUBLISH_RELAY_GOOGLE_CLIENT_SECRET,
        }),
        workerId: config.WORKER_ID ?? 'publish-relay-worker',
        leaseMs: Math.max(config.WORKER_POLL_INTERVAL_MS * 10, 30_000),
      }
    : null;
const linkedinRuntime =
  config.PUBLISH_RELAY_LINKEDIN_CLIENT_ID && config.PUBLISH_RELAY_LINKEDIN_CLIENT_SECRET
    ? {
        database,
        keys,
        source: createLocalXMediaSource(database, config.MEDIA_STORAGE_ROOT),
        client: new LinkedInHttpClient({
          clientId: config.PUBLISH_RELAY_LINKEDIN_CLIENT_ID,
          clientSecret: config.PUBLISH_RELAY_LINKEDIN_CLIENT_SECRET,
        }),
        workerId: config.WORKER_ID ?? 'publish-relay-worker',
        leaseMs: Math.max(config.WORKER_POLL_INTERVAL_MS * 10, 30_000),
      }
    : null;
const instagramRuntime =
  config.PUBLISH_RELAY_META_GRAPH_VERSION &&
  config.PUBLISH_RELAY_PUBLIC_ORIGIN &&
  config.CURSOR_SIGNING_SECRET
    ? {
        database,
        keys,
        client: new InstagramHttpClient({ graphVersion: config.PUBLISH_RELAY_META_GRAPH_VERSION }),
        ...(config.PUBLISH_RELAY_INSTAGRAM_APP_ID && config.PUBLISH_RELAY_INSTAGRAM_APP_SECRET
          ? {
              loginClient: new InstagramHttpClient({
                graphVersion: config.PUBLISH_RELAY_META_GRAPH_VERSION,
                transport: 'instagram_login' as const,
              }),
              loginTokenClient: new InstagramLoginClient({
                appId: config.PUBLISH_RELAY_INSTAGRAM_APP_ID,
                appSecret: config.PUBLISH_RELAY_INSTAGRAM_APP_SECRET,
                graphVersion: config.PUBLISH_RELAY_META_GRAPH_VERSION,
              }),
            }
          : {}),
        tokenCodec: new InstagramMediaTokenCodec(Buffer.from(config.CURSOR_SIGNING_SECRET)),
        publicOrigin: config.PUBLISH_RELAY_PUBLIC_ORIGIN,
        workerId: config.WORKER_ID ?? 'publish-relay-worker',
        leaseMs: Math.max(config.WORKER_POLL_INTERVAL_MS * 10, 30_000),
      }
    : null;
const facebookRuntime =
  instagramRuntime && config.PUBLISH_RELAY_META_GRAPH_VERSION
    ? {
        ...instagramRuntime,
        client: new FacebookHttpClient({ graphVersion: config.PUBLISH_RELAY_META_GRAPH_VERSION }),
      }
    : null;
const tiktokConfig = resolveTikTokProviderConfig(config);
const tiktokRuntime =
  tiktokConfig && config.CURSOR_SIGNING_SECRET
    ? {
        database,
        keys,
        client: new TikTokHttpClient(tiktokConfig),
        grants: new TikTokMediaGrantService(database, Buffer.from(config.CURSOR_SIGNING_SECRET)),
        workerId: config.WORKER_ID ?? 'publish-relay-worker',
        leaseMs: Math.max(config.WORKER_POLL_INTERVAL_MS * 10, 30_000),
        publicOrigin: tiktokConfig.publicOrigin,
        verifiedMediaOrigin: tiktokConfig.verifiedMediaOrigin,
      }
    : null;
const fanvueRuntime =
  config.PUBLISH_RELAY_FANVUE_CLIENT_ID && config.PUBLISH_RELAY_FANVUE_CLIENT_SECRET
    ? {
        database,
        keys,
        storage: mediaStorage,
        oauthClient: new FanvueHttpClient({
          clientId: config.PUBLISH_RELAY_FANVUE_CLIENT_ID,
          clientSecret: config.PUBLISH_RELAY_FANVUE_CLIENT_SECRET,
        }),
        mediaClient: new FanvueMediaUploadClient(),
        postClient: new FanvuePostClient(),
        workerId: config.WORKER_ID ?? 'publish-relay-worker',
        leaseMs: Math.max(config.WORKER_POLL_INTERVAL_MS * 10, 30_000),
      }
    : null;
if (!xRuntime)
  process.stdout.write(
    `${JSON.stringify({ event: 'provider_disabled', provider: 'x', reason: 'missing_configuration' })}\n`,
  );
if (!youtubeRuntime)
  process.stdout.write(
    `${JSON.stringify({ event: 'provider_disabled', provider: 'youtube', reason: 'missing_configuration' })}\n`,
  );
if (!linkedinRuntime)
  process.stdout.write(
    `${JSON.stringify({ event: 'provider_disabled', provider: 'linkedin', reason: 'missing_configuration' })}\n`,
  );
if (!instagramRuntime)
  process.stdout.write(
    `${JSON.stringify({ event: 'provider_disabled', provider: 'instagram', reason: 'missing_configuration' })}\n`,
  );
if (!facebookRuntime)
  process.stdout.write(
    `${JSON.stringify({ event: 'provider_disabled', provider: 'facebook_page', reason: 'missing_configuration' })}\n`,
  );
if (!tiktokRuntime)
  process.stdout.write(
    `${JSON.stringify({ event: 'provider_disabled', provider: 'tiktok', reason: 'missing_configuration' })}\n`,
  );
if (!fanvueRuntime)
  process.stdout.write(
    `${JSON.stringify({ event: 'provider_disabled', provider: 'fanvue', reason: 'missing_configuration' })}\n`,
  );

const destinationDispatchAdapters: DestinationDispatchAdapter[] = [];
if (xRuntime)
  destinationDispatchAdapters.push({
    destinationProvider: 'x',
    dispatch: () => dispatchDueXJobs(xRuntime),
    reconcile: () => reconcileXJobs(xRuntime),
  });
if (youtubeRuntime)
  destinationDispatchAdapters.push({
    destinationProvider: 'youtube',
    dispatch: () => dispatchDueYouTubeJobs(youtubeRuntime),
    reconcile: () => reconcileYouTubeJobs(youtubeRuntime),
  });
if (linkedinRuntime)
  destinationDispatchAdapters.push({
    destinationProvider: 'linkedin',
    dispatch: () => dispatchDueLinkedInJobs(linkedinRuntime),
    reconcile: () => Promise.resolve(0),
  });
if (instagramRuntime)
  destinationDispatchAdapters.push({
    destinationProvider: 'instagram',
    dispatch: () => dispatchDueInstagramJobs(instagramRuntime),
    reconcile: () => reconcileInstagramJobs(instagramRuntime),
  });
if (facebookRuntime)
  destinationDispatchAdapters.push({
    destinationProvider: 'facebook_page',
    dispatch: () => dispatchDueFacebookJobs(facebookRuntime),
    reconcile: () => reconcileFacebookJobs(facebookRuntime),
  });
if (tiktokRuntime)
  destinationDispatchAdapters.push({
    destinationProvider: 'tiktok',
    dispatch: () => dispatchDueTikTokJobs(tiktokRuntime),
    reconcile: () => reconcileTikTokDirectPosts(tiktokRuntime),
  });
if (fanvueRuntime)
  destinationDispatchAdapters.push({
    destinationProvider: 'fanvue',
    dispatch: () => dispatchDueFanvueJobs(fanvueRuntime),
    reconcile: () => Promise.resolve(0),
  });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shutdownController.abort();
  });
}

while (!shutdownController.signal.aborted) {
  if (authEmailDelivery) {
    const authEmail = await dispatchAuthEmailOutbox(database, keys, authEmailDelivery, {
      workerId: config.WORKER_ID ?? 'publish-relay-worker',
      leaseMs: Math.max(config.WORKER_POLL_INTERVAL_MS * 10, 30_000),
    });
    if (authEmail.sent || authEmail.failed)
      process.stdout.write(`${JSON.stringify({ event: 'auth_email_cycle', ...authEmail })}\n`);
  }
  const destinationFailures = await runDestinationDispatchCycle(destinationDispatchAdapters);
  for (const failure of destinationFailures)
    process.stderr.write(`${JSON.stringify({ event: 'destination_cycle_failed', ...failure })}\n`);
  if (facebookRuntime) {
    try {
      const pageDms = await dispatchDuePageDms({
        ...facebookRuntime,
        workerId: config.WORKER_ID ?? 'publish-relay-worker',
        leaseMs: Math.max(config.WORKER_POLL_INTERVAL_MS * 10, 30_000),
      });
      if (pageDms.confirmed || pageDms.failed || pageDms.unknown)
        process.stdout.write(
          `${JSON.stringify({ event: 'facebook_page_dm_cycle', ...pageDms })}\n`,
        );
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({ event: 'facebook_page_dm_cycle_failed', error: String(error) })}\n`,
      );
    }
  }
  const now = new Date();
  const deletedStagingObjects = await reconcileMediaStaging(now);
  if (deletedStagingObjects !== undefined) {
    process.stdout.write(
      `${JSON.stringify({ event: 'media_staging_reconciliation', deleted: deletedStagingObjects })}\n`,
    );
  }
  if (now.getTime() >= nextMediaRetentionAt) {
    const providerStaging = await runProviderStagingCleanupCycle(
      database,
      {
        batchSize: config.MEDIA_RETENTION_BATCH_SIZE ?? 100,
        terminalGraceMs: PROVIDER_STAGING_TERMINAL_GRACE_MS,
      },
      now,
    );
    process.stdout.write(
      `${JSON.stringify({ event: 'provider_staging_cleanup_cycle', ...providerStaging })}\n`,
    );
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
