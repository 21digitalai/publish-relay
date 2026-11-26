import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveEnabledAdapters,
  resolveHumanAuthMode,
  type RuntimeConfig,
} from '../config/runtime-config.js';
import { registerApiDocumentationRoute } from '../modules/api/openapi.js';
import { registerAgentDiscoveryRoutes } from '../modules/api/agent-discovery.js';
import { ApiRateLimiter } from '../modules/api/rate-limit.js';
import { CursorCodec } from '../modules/api/contract.js';
import type { AuthService } from '../modules/identity/auth.service.js';
import {
  registerAuthRoutes,
  registerPublicAuthShellRoutes,
} from '../modules/identity/auth.routes.js';
import type { MagicLinkService } from '../modules/identity/magic-link.service.js';
import { registerMagicLinkRoutes } from '../modules/identity/magic-link.routes.js';
import type { ApiKeyService } from '../modules/identity/api-key.service.js';
import { registerApiKeyRoutes } from '../modules/identity/api-key.routes.js';
import { registerPostRoutes } from '../modules/content/post.routes.js';
import { registerExternalDraftRoutes } from '../modules/content/external-draft.routes.js';
import { registerBrowserWorkflowRoutes } from '../modules/content/browser-workflow.routes.js';
import type { MediaStorage } from '../modules/content/media-storage.js';
import {
  AGENT_MEDIA_MAX_BYTES,
  AGENT_VIDEO_LIMITS,
  registerMediaRoutes,
} from '../modules/content/media.routes.js';
import type { MasterKeyProvider } from '../modules/credentials/envelope.js';
import type { XHttpClient } from '../modules/providers/x-http-client.js';
import { registerXOauthRoutes } from '../modules/providers/x-oauth.routes.js';
import type { YouTubeHttpClient } from '../modules/providers/youtube-http-client.js';
import { registerYouTubeOauthRoutes } from '../modules/providers/youtube-oauth.routes.js';
import type { LinkedInHttpClient } from '../modules/providers/linkedin-http-client.js';
import { registerLinkedInOauthRoutes } from '../modules/providers/linkedin-oauth.routes.js';
import type { MetaHttpClient, MetaPermission } from '../modules/providers/meta-http-client.js';
import type { FacebookHttpClient } from '../modules/providers/facebook-http-client.js';
import { registerFacebookPageReadRoutes } from '../modules/providers/facebook-page-read.routes.js';
import { registerFacebookDmMemoryRoutes } from '../modules/providers/facebook-dm-memory.routes.js';
import { registerFacebookPageCommentSendRoute } from '../modules/providers/facebook-comment-send.routes.js';
import { registerFacebookPageCommentScheduleRoutes } from '../modules/providers/facebook-comment-schedule.routes.js';
import { scheduleApprovedPageComment } from '../modules/providers/facebook-comment-approval.service.js';
import { registerFacebookPageDmSendRoute } from '../modules/providers/facebook-messenger-send.routes.js';
import { sendAccountPageCommentReply } from '../modules/providers/facebook-comment-send.service.js';
import {
  getPageDmApprovalWindow,
  sendAccountPageConversationMessage,
} from '../modules/providers/facebook-messenger-send.service.js';
import { registerFacebookPageBrowserReadRoutes } from '../modules/providers/facebook-page-browser-read.routes.js';
import { registerInstagramUnifiedReadApiRoutes, registerInstagramUnifiedReadRoutes } from '../modules/providers/instagram-unified-read.routes.js';
import { registerInstagramUnifiedSendApiRoutes, registerInstagramUnifiedSendRoutes } from '../modules/providers/instagram-unified-send.routes.js';
import { registerInstagramUnifiedScheduleRoutes } from '../modules/providers/instagram-unified-schedule.routes.js';
import type { InstagramUnifiedReadClient } from '../modules/providers/instagram-unified-read-client.js';
import { registerMetaOauthRoutes } from '../modules/providers/meta-oauth.routes.js';
import type { TikTokHttpClient } from '../modules/providers/tiktok-http-client.js';
import { registerTikTokOauthRoutes } from '../modules/providers/tiktok-oauth.routes.js';
import type { SnapchatHttpClient } from '../modules/providers/snapchat-http-client.js';
import { registerSnapchatOauthRoutes } from '../modules/providers/snapchat-oauth.routes.js';
import type { FanvueHttpClient } from '../modules/providers/fanvue-http-client.js';
import { registerFanvueOauthRoutes } from '../modules/providers/fanvue-oauth.routes.js';
import { FanvueReadClient } from '../modules/providers/fanvue-read-client.js';
import { FanvueReadService } from '../modules/providers/fanvue-read.service.js';
import { FanvueCommentClient } from '../modules/providers/fanvue-comment-client.js';
import { FanvueCommentService } from '../modules/providers/fanvue-comment.service.js';
import { registerFanvueCommentRoutes } from '../modules/providers/fanvue-comment.routes.js';
import { FanvueMessageClient } from '../modules/providers/fanvue-message-client.js';
import { FanvueMessageService } from '../modules/providers/fanvue-message.service.js';
import { registerFanvueMessageRoutes } from '../modules/providers/fanvue-message.routes.js';
import { registerFanvueDmStageRoutes } from '../modules/providers/fanvue-dm-stage.routes.js';
import { stageFanvueDmMediaStep } from '../modules/providers/fanvue-dm-stage-step.service.js';
import { FanvueMediaUploadClient } from '../modules/providers/fanvue-media-upload-client.js';
import {
  registerFanvueBrowserReadRoutes,
  registerFanvueReadRoutes,
} from '../modules/providers/fanvue-read.routes.js';
import { registerFanvueVaultCatalogRoutes } from '../modules/providers/fanvue-vault-catalog.routes.js';
import { registerTikTokConsentRoutes } from '../modules/providers/tiktok-consent.routes.js';
import { registerTikTokDraftRoutes } from '../modules/providers/tiktok-draft.routes.js';
import { registerTikTokScheduleRoutes } from '../modules/providers/tiktok-schedule.routes.js';
import { registerSnapchatStoryResolutionRoutes } from '../modules/providers/snapchat-story-resolution.routes.js';
import { registerFanvuePaymentRoutes } from '../modules/providers/fanvue-payment.routes.js';
import { registerFanvuePaymentWebhook } from '../modules/providers/fanvue-payment-webhook.routes.js';
import { registerEngagementProposalRoutes } from '../modules/providers/engagement-proposal.routes.js';
import { registerEngagementApprovalRoutes } from '../modules/providers/engagement-approval.routes.js';
import type { EngagementSendCommands } from '../modules/providers/engagement-approval.service.js';
import { registerEngagementDmMediaRoutes } from '../modules/providers/engagement-dm-media.routes.js';
import { registerInstagramMediaRoutes } from '../modules/providers/instagram-media.routes.js';
import type { InstagramLoginClient } from '../modules/providers/instagram-login-client.js';
import { registerInstagramLoginRoutes } from '../modules/providers/instagram-login.routes.js';
import type { InstagramUnifiedLoginClient } from '../modules/providers/instagram-unified-login-client.js';
import { registerInstagramUnifiedLoginRoutes } from '../modules/providers/instagram-unified-login.routes.js';
import { InstagramMediaTokenCodec } from '../modules/providers/instagram-media-token.js';
import { registerTikTokMediaRoutes } from '../modules/providers/tiktok-media.routes.js';
import { TikTokMediaGrantService } from '../modules/providers/tiktok-media-grant.service.js';
import { registerProviderAccountRoutes } from '../modules/credentials/provider-account.routes.js';
import { registerFanvueGuidanceRoutes } from '../modules/credentials/fanvue-guidance.routes.js';
import { registerFacebookPageGuidanceRoutes } from '../modules/credentials/facebook-page-guidance.routes.js';
import { registerDestinationRoutes } from '../modules/credentials/destination.routes.js';
import { allowAllActionPolicy, type ActionPolicy } from '../modules/policy/action-policy.js';
import {
  registerRedactedErrorHandler,
  registerRedactedNotFoundHandler,
  requestLoggerOptions,
} from './request-logger.js';
import type { DelegatedAuthorizationService } from '../modules/delegated-authorization/delegated-authorization.service.js';
import { registerDelegatedAuthorizationRoutes } from '../modules/delegated-authorization/delegated-authorization.routes.js';

interface XOauthOptions {
  keys: MasterKeyProvider;
  client: XHttpClient;
  callbackUrl: string;
}
interface YouTubeOauthOptions {
  keys: MasterKeyProvider;
  client: YouTubeHttpClient;
  callbackUrl: string;
}
interface LinkedInOauthOptions {
  keys: MasterKeyProvider;
  client: LinkedInHttpClient;
  callbackUrl: string;
}
interface MetaOauthOptions {
  keys: MasterKeyProvider;
  client: MetaHttpClient;
  callbackUrl: string;
  familyPermissions?: Partial<Record<'facebook_pages' | 'instagram', readonly MetaPermission[]>>;
}
interface FacebookReadOptions {
  keys: MasterKeyProvider;
  client: FacebookHttpClient;
}
interface InstagramOauthOptions {
  keys: MasterKeyProvider;
  client: InstagramLoginClient;
  callbackUrl: string;
}
interface InstagramUnifiedOauthOptions {
  keys: MasterKeyProvider;
  client: InstagramUnifiedLoginClient;
  readClient?: InstagramUnifiedReadClient;
  callbackUrl: string;
}
interface TikTokOauthOptions {
  keys: MasterKeyProvider;
  client: TikTokHttpClient;
  callbackUrl: string;
}
interface SnapchatOauthOptions {
  keys: MasterKeyProvider;
  client: SnapchatHttpClient;
  callbackUrl: string;
}
interface FanvueOauthOptions {
  keys: MasterKeyProvider;
  client: FanvueHttpClient;
  callbackUrl: string;
  readClient?: FanvueReadClient;
}

export interface CoreApplicationOptions {
  config: RuntimeConfig;
  auth?: AuthService;
  apiKeys?: ApiKeyService;
  uiRoot?: string;
  uiPrefix?: string;
  database?: NodePgDatabase;
  xOauth?: XOauthOptions;
  mediaStorage?: MediaStorage;
  actionPolicy?: ActionPolicy;
  youtubeOauth?: YouTubeOauthOptions;
  linkedinOauth?: LinkedInOauthOptions;
  metaOauth?: MetaOauthOptions;
  facebookRead?: FacebookReadOptions;
  instagramOauth?: InstagramOauthOptions;
  instagramUnifiedOauth?: InstagramUnifiedOauthOptions;
  tiktokOauth?: TikTokOauthOptions;
  snapchatOauth?: SnapchatOauthOptions;
  fanvueOauth?: FanvueOauthOptions;
  delegatedAuthorization?: DelegatedAuthorizationService;
  magicLinks?: MagicLinkService;
  publicAuthShells?: boolean;
}

export type StandaloneApplicationOptions = Omit<CoreApplicationOptions, 'publicAuthShells'>;

function registerOperationalRoutes(
  application: FastifyInstance,
  database: NodePgDatabase | undefined,
  magicLinks: MagicLinkService | undefined,
): void {
  application.get('/health/live', () => ({ data: { status: 'ok' }, error: null }));
  application.get('/health/ready', async (_request, reply) => {
    if (!database) return reply.code(503).send({ data: null, error: 'Database is not configured' });
    try {
      await database.execute(sql`select 1`);
      return { data: { status: 'ready' }, error: null };
    } catch {
      return reply.code(503).send({ data: null, error: 'Database is unavailable' });
    }
  });
  application.get('/metrics', (_request, reply) => {
    const memory = process.memoryUsage();
    const body = [
      '# HELP publish_relay_process_uptime_seconds Process uptime in seconds.',
      '# TYPE publish_relay_process_uptime_seconds gauge',
      `publish_relay_process_uptime_seconds ${String(process.uptime())}`,
      '# HELP publish_relay_process_resident_memory_bytes Resident memory in bytes.',
      '# TYPE publish_relay_process_resident_memory_bytes gauge',
      `publish_relay_process_resident_memory_bytes ${String(memory.rss)}`,
      ...(magicLinks ? magicLinks.metrics.renderPrometheus() : []),
      '',
    ].join('\n');
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(body);
  });
  application.get('/api', () => ({ data: { name: 'Publish Relay' }, error: null }));
}

function createApiRateLimiter(): ApiRateLimiter {
  return new ApiRateLimiter({
    workspace: 600,
    key: 300,
    mutationWorkspace: 120,
    mutationKey: 60,
    windowMs: 60_000,
  });
}

function registerMachineApiRoutes(
  application: FastifyInstance,
  options: CoreApplicationOptions,
  actionPolicy: ActionPolicy,
): void {
  const { config, apiKeys, auth, database, delegatedAuthorization, mediaStorage, instagramUnifiedOauth } = options;
  if (!apiKeys) return;
  const rateLimiter = createApiRateLimiter();
  registerApiKeyRoutes(application, apiKeys, rateLimiter, auth, delegatedAuthorization);
  if (!database) return;
  const enabledAdapters = resolveEnabledAdapters(config);
  if (enabledAdapters.has('fanvue'))
    registerFanvueGuidanceRoutes(
      application,
      database,
      auth,
      apiKeys,
      rateLimiter,
      delegatedAuthorization,
    );
  if (enabledAdapters.has('facebook_page'))
    registerFacebookPageGuidanceRoutes(
      application,
      database,
      auth,
      apiKeys,
      rateLimiter,
      delegatedAuthorization,
    );
  registerDestinationRoutes(
    application,
    database,
    apiKeys,
    rateLimiter,
    delegatedAuthorization,
    options.tiktokOauth
      ? { keys: options.tiktokOauth.keys, client: options.tiktokOauth.client }
      : undefined,
    resolveEnabledAdapters(config),
  );
  if (enabledAdapters.has('facebook_page') && options.facebookRead) {
    const facebook = { database, ...options.facebookRead };
    registerFacebookDmMemoryRoutes(
      application,
      database,
      apiKeys,
      rateLimiter,
      delegatedAuthorization,
    );
    registerFacebookPageReadRoutes(
      application,
      facebook,
      apiKeys,
      rateLimiter,
      delegatedAuthorization,
    );
    registerFacebookPageCommentSendRoute(
      application,
      { ...facebook, policy: actionPolicy },
      apiKeys,
      rateLimiter,
      delegatedAuthorization,
    );
    registerFacebookPageCommentScheduleRoutes(
      application,
      { ...facebook, policy: actionPolicy },
      apiKeys,
      rateLimiter,
      delegatedAuthorization,
    );
    registerFacebookPageDmSendRoute(
      application,
      { ...facebook, policy: actionPolicy },
      apiKeys,
      rateLimiter,
      delegatedAuthorization,
    );
  }
  if (instagramUnifiedOauth?.readClient)
    registerInstagramUnifiedReadApiRoutes(application, { database, keys: instagramUnifiedOauth.keys, client: instagramUnifiedOauth.readClient }, apiKeys, rateLimiter, delegatedAuthorization);
  if (instagramUnifiedOauth?.readClient)
    registerInstagramUnifiedSendApiRoutes(application, { database, keys: instagramUnifiedOauth.keys, client: instagramUnifiedOauth.readClient }, apiKeys, rateLimiter, delegatedAuthorization);
  if (enabledAdapters.has('fanvue') && options.fanvueOauth) {
    const reads = new FanvueReadService(
      database,
      options.fanvueOauth.keys,
      options.fanvueOauth.client,
      options.fanvueOauth.readClient ?? new FanvueReadClient(),
    );
    registerFanvueReadRoutes(application, reads, apiKeys, rateLimiter, delegatedAuthorization);
    registerFanvueVaultCatalogRoutes(application, {
      database,
      reads,
      apiKeys,
      rateLimiter,
      ...(auth ? { auth } : {}),
      ...(delegatedAuthorization ? { delegatedAuthorization } : {}),
    });
    registerFanvueCommentRoutes(
      application,
      new FanvueCommentService(database, reads, new FanvueCommentClient(), actionPolicy),
      apiKeys,
      rateLimiter,
      delegatedAuthorization,
      database,
    );
    registerFanvueMessageRoutes(
      application,
      new FanvueMessageService(database, reads, new FanvueMessageClient(), actionPolicy),
      apiKeys,
      rateLimiter,
      delegatedAuthorization,
    );
    if (mediaStorage) {
      const uploadClient = new FanvueMediaUploadClient();
      const keys = options.fanvueOauth.keys;
      registerFanvueDmStageRoutes(
        application,
        (input) => stageFanvueDmMediaStep(database, mediaStorage, uploadClient, keys, reads, input),
        apiKeys,
        rateLimiter,
        delegatedAuthorization,
      );
    }
  }
  if (!config.CURSOR_SIGNING_SECRET)
    throw new Error('CURSOR_SIGNING_SECRET is required for API routes');
  registerPostRoutes(
    application,
    database,
    apiKeys,
    rateLimiter,
    new CursorCodec(Buffer.from(config.CURSOR_SIGNING_SECRET)),
    actionPolicy,
    delegatedAuthorization,
    resolveEnabledAdapters(config),
  );
  registerExternalDraftRoutes(application, database, apiKeys, rateLimiter, delegatedAuthorization);
  if (enabledAdapters.has('fanvue'))
    registerFanvuePaymentRoutes(application, {
      database,
      apiKeys,
      rateLimiter,
      ...(delegatedAuthorization ? { delegatedAuthorization } : {}),
    });
  registerEngagementProposalRoutes(application, {
    database,
    apiKeys,
    rateLimiter,
    enabledAdapters,
    ...(delegatedAuthorization ? { delegatedAuthorization } : {}),
  });
  if (!mediaStorage) return;
  registerMediaRoutes(
    application,
    database,
    mediaStorage,
    apiKeys,
    rateLimiter,
    actionPolicy,
    undefined,
    {
      maxBytes: config.MEDIA_VIDEO_MAX_BYTES ?? AGENT_MEDIA_MAX_BYTES,
      limits: {
        maxDurationMs: config.MEDIA_VIDEO_MAX_DURATION_MS ?? AGENT_VIDEO_LIMITS.maxDurationMs,
        maxWidth: config.MEDIA_VIDEO_MAX_WIDTH ?? AGENT_VIDEO_LIMITS.maxWidth,
        maxHeight: config.MEDIA_VIDEO_MAX_HEIGHT ?? AGENT_VIDEO_LIMITS.maxHeight,
      },
    },
    delegatedAuthorization,
  );
}

function registerBrowserRoutes(
  application: FastifyInstance,
  options: CoreApplicationOptions,
  actionPolicy: ActionPolicy,
  shellHtml: string,
): void {
  const {
    config,
    auth,
    database,
    mediaStorage,
    xOauth,
    youtubeOauth,
    linkedinOauth,
    metaOauth,
    instagramOauth,
    instagramUnifiedOauth,
    tiktokOauth,
    snapchatOauth,
    fanvueOauth,
    delegatedAuthorization,
  } = options;
  const enabledAdapters = resolveEnabledAdapters(config);
  if (database && mediaStorage && config.CURSOR_SIGNING_SECRET) {
    if (enabledAdapters.has('instagram'))
      registerInstagramMediaRoutes(application, {
        database,
        mediaStorage,
        tokenCodec: new InstagramMediaTokenCodec(Buffer.from(config.CURSOR_SIGNING_SECRET)),
      });
    if (enabledAdapters.has('tiktok'))
      registerTikTokMediaRoutes(application, {
        grants: new TikTokMediaGrantService(database, Buffer.from(config.CURSOR_SIGNING_SECRET)),
        mediaStorage,
      });
  }
  if (auth && database) {
    if (instagramUnifiedOauth?.readClient)
      registerInstagramUnifiedReadRoutes(application, { database, keys: instagramUnifiedOauth.keys, client: instagramUnifiedOauth.readClient }, auth);
    if (instagramUnifiedOauth?.readClient)
      registerInstagramUnifiedSendRoutes(application, { database, keys: instagramUnifiedOauth.keys, client: instagramUnifiedOauth.readClient }, auth);
    if (instagramUnifiedOauth?.readClient)
      registerInstagramUnifiedScheduleRoutes(application, { database, keys: instagramUnifiedOauth.keys, client: instagramUnifiedOauth.readClient }, auth);
    if (enabledAdapters.has('facebook_page') && options.facebookRead)
      registerFacebookPageBrowserReadRoutes(
        application,
        { database, ...options.facebookRead },
        auth,
      );
    registerEngagementProposalRoutes(application, {
      database,
      auth,
      enabledAdapters,
    });
    const facebookRuntime =
      enabledAdapters.has('facebook_page') && options.facebookRead
        ? { database, ...options.facebookRead, policy: actionPolicy }
        : null;
    const approvalCommands: EngagementSendCommands = {
      ...(facebookRuntime
        ? {
            facebook: {
              scheduleComment: (input: Parameters<typeof scheduleApprovedPageComment>[1]) =>
                scheduleApprovedPageComment(facebookRuntime, input),
              previewDmWindow: (input: {
                workspaceId: string;
                accountId: string;
                conversationId: string;
              }) => getPageDmApprovalWindow(facebookRuntime, input),
              sendComment: (input: Parameters<typeof sendAccountPageCommentReply>[1]) =>
                sendAccountPageCommentReply(facebookRuntime, input),
              sendDm: (input: Parameters<typeof sendAccountPageConversationMessage>[1]) =>
                sendAccountPageConversationMessage(facebookRuntime, input),
            },
          }
        : {}),
    };
    if (enabledAdapters.has('fanvue') && fanvueOauth) {
      const reads = new FanvueReadService(
        database,
        fanvueOauth.keys,
        fanvueOauth.client,
        fanvueOauth.readClient ?? new FanvueReadClient(),
      );
      approvalCommands.comments = new FanvueCommentService(
        database,
        reads,
        new FanvueCommentClient(),
        actionPolicy,
      );
      approvalCommands.messages = new FanvueMessageService(
        database,
        reads,
        new FanvueMessageClient(),
        actionPolicy,
      );
      if (mediaStorage) {
        const uploadClient = new FanvueMediaUploadClient();
        registerEngagementDmMediaRoutes(application, {
          database,
          auth,
          stage: (input) =>
            stageFanvueDmMediaStep(
              database,
              mediaStorage,
              uploadClient,
              fanvueOauth.keys,
              reads,
              input,
            ),
        });
      }
    }
    if (approvalCommands.facebook || approvalCommands.comments)
      registerEngagementApprovalRoutes(application, { database, auth, ...approvalCommands });
    registerProviderAccountRoutes(application, {
      auth,
      database,
      enabledAdapters,
      ...(tiktokOauth ? { tiktok: { keys: tiktokOauth.keys, client: tiktokOauth.client } } : {}),
    });
    if (enabledAdapters.has('tiktok')) {
      registerTikTokConsentRoutes(application, { auth, database });
      registerTikTokDraftRoutes(application, { auth, database, actionPolicy });
      registerTikTokScheduleRoutes(application, {
        auth,
        database,
        actionPolicy,
        enabled: Boolean(tiktokOauth),
      });
    }
    if (enabledAdapters.has('snapchat'))
      registerSnapchatStoryResolutionRoutes(application, { auth, database });
    registerBrowserWorkflowRoutes(application, {
      auth,
      database,
      actionPolicy,
      enabledAdapters,
      ...(mediaStorage ? { mediaStorage } : {}),
      videoConfig: {
        maxBytes: config.MEDIA_VIDEO_MAX_BYTES ?? AGENT_MEDIA_MAX_BYTES,
        limits: {
          maxDurationMs: config.MEDIA_VIDEO_MAX_DURATION_MS ?? AGENT_VIDEO_LIMITS.maxDurationMs,
          maxWidth: config.MEDIA_VIDEO_MAX_WIDTH ?? AGENT_VIDEO_LIMITS.maxWidth,
          maxHeight: config.MEDIA_VIDEO_MAX_HEIGHT ?? AGENT_VIDEO_LIMITS.maxHeight,
        },
      },
    });
  }
  if (auth && database && enabledAdapters.has('x') && xOauth)
    registerXOauthRoutes(application, { auth, database, actionPolicy, ...xOauth });
  if (auth && database && enabledAdapters.has('youtube') && youtubeOauth)
    registerYouTubeOauthRoutes(application, { auth, database, actionPolicy, ...youtubeOauth });
  if (auth && database && enabledAdapters.has('linkedin') && linkedinOauth)
    registerLinkedInOauthRoutes(application, { auth, database, actionPolicy, ...linkedinOauth });
  if (auth && database && enabledAdapters.has('facebook_page') && metaOauth)
    registerMetaOauthRoutes(application, { auth, database, actionPolicy, ...metaOauth });
  if (auth && database && enabledAdapters.has('instagram'))
    registerInstagramLoginRoutes(application, {
      auth,
      database,
      actionPolicy,
      ...(instagramOauth ? { oauth: instagramOauth } : {}),
    });
  if (auth && database && enabledAdapters.has('instagram'))
    registerInstagramUnifiedLoginRoutes(application, {
      auth,
      database,
      actionPolicy,
      ...(instagramUnifiedOauth ? { oauth: instagramUnifiedOauth } : {}),
    });
  if (auth && database && enabledAdapters.has('tiktok') && tiktokOauth)
    registerTikTokOauthRoutes(application, { auth, database, actionPolicy, ...tiktokOauth });
  if (auth && database && enabledAdapters.has('snapchat') && snapchatOauth)
    registerSnapchatOauthRoutes(application, { auth, database, actionPolicy, ...snapchatOauth });
  if (auth && database && enabledAdapters.has('fanvue') && fanvueOauth)
    registerFanvueOauthRoutes(application, { auth, database, actionPolicy, ...fanvueOauth });
  if (database && enabledAdapters.has('fanvue') && fanvueOauth)
    registerFanvuePaymentWebhook(application, { database, keys: fanvueOauth.keys });
  if (auth && database && enabledAdapters.has('fanvue') && fanvueOauth)
    registerFanvueBrowserReadRoutes(
      application,
      new FanvueReadService(
        database,
        fanvueOauth.keys,
        fanvueOauth.client,
        fanvueOauth.readClient ?? new FanvueReadClient(),
      ),
      auth,
      createApiRateLimiter(),
    );
  if (auth && delegatedAuthorization)
    registerDelegatedAuthorizationRoutes(application, delegatedAuthorization, auth, shellHtml);
}

export function registerCoreApplication(
  application: FastifyInstance,
  options: CoreApplicationOptions,
): FastifyInstance {
  const {
    config,
    auth,
    database,
    actionPolicy = allowAllActionPolicy,
    publicAuthShells = false,
  } = options;
  const uiRoot = options.uiRoot ?? fileURLToPath(new URL('../ui/', import.meta.url));
  const uiPrefix = options.uiPrefix ?? '/';
  const enabledAdapterSet = resolveEnabledAdapters(config);
  const enabledAdapters = [...enabledAdapterSet].join(',');
  const shellHtml = readFileSync(resolve(uiRoot, 'index.html'), 'utf8')
    .replace(
      '<body>',
      `<body data-human-auth-mode="${resolveHumanAuthMode(config)}" data-enabled-adapters="${enabledAdapters}" data-linkedin-enabled="${String(enabledAdapterSet.has('linkedin') && Boolean(options.linkedinOauth))}" data-tiktok-enabled="${String(enabledAdapterSet.has('tiktok') && Boolean(options.tiktokOauth))}" data-fanvue-enabled="${String(enabledAdapterSet.has('fanvue') && Boolean(options.fanvueOauth))}">`,
    )
    .replaceAll('="/assets/', `="${uiPrefix === '/' ? '/' : uiPrefix}assets/`)
    .replace('href="/favicon.svg"', `href="${uiPrefix === '/' ? '/' : uiPrefix}favicon.svg"`);

  application.register(fastifyStatic, {
    root: uiRoot,
    wildcard: false,
    prefix: uiPrefix,
    decorateReply: false,
  });

  registerOperationalRoutes(application, database, options.magicLinks);
  registerApiDocumentationRoute(application);
  registerAgentDiscoveryRoutes(application);
  if (auth)
    registerAuthRoutes(application, auth, {
      secureCookies: config.NODE_ENV === 'production',
      shellHtml,
      humanAuthMode: resolveHumanAuthMode(config),
    });
  if (auth && publicAuthShells) registerPublicAuthShellRoutes(application, shellHtml, auth);
  if (options.magicLinks && resolveHumanAuthMode(config) === 'magic_link')
    registerMagicLinkRoutes(application, options.magicLinks, {
      secureCookies: config.NODE_ENV === 'production',
    });
  registerMachineApiRoutes(application, options, actionPolicy);
  registerBrowserRoutes(application, options, actionPolicy, shellHtml);
  registerRedactedErrorHandler(application);
  registerRedactedNotFoundHandler(application);

  return application;
}

export function createStandaloneApplication(
  options: StandaloneApplicationOptions,
): FastifyInstance {
  const application = Fastify({
    logger: options.config.NODE_ENV === 'test' ? false : requestLoggerOptions,
    // The standalone listener is bound to loopback behind the local TLS reverse proxy.
    // Never trust forwarded addresses from a directly connected remote client.
    trustProxy: (address) => address === '127.0.0.1' || address === '::1',
  });
  return registerCoreApplication(application, { ...options, publicAuthShells: true });
}
