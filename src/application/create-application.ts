import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveHumanAuthMode, type RuntimeConfig } from '../config/runtime-config.js';
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
import { registerProviderAccountRoutes } from '../modules/credentials/provider-account.routes.js';
import { registerDestinationRoutes } from '../modules/credentials/destination.routes.js';
import { allowAllActionPolicy, type ActionPolicy } from '../modules/policy/action-policy.js';
import { registerRedactedNotFoundHandler, requestLoggerOptions } from './request-logger.js';
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
  const { config, apiKeys, auth, database, delegatedAuthorization, mediaStorage } = options;
  if (!apiKeys) return;
  const rateLimiter = createApiRateLimiter();
  registerApiKeyRoutes(application, apiKeys, rateLimiter, auth, delegatedAuthorization);
  if (!database) return;
  registerDestinationRoutes(application, database, apiKeys, rateLimiter, delegatedAuthorization);
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
  );
  registerExternalDraftRoutes(application, database, apiKeys, rateLimiter, delegatedAuthorization);
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
  const { config, auth, database, mediaStorage, xOauth, youtubeOauth, delegatedAuthorization } =
    options;
  if (auth && database) {
    registerProviderAccountRoutes(application, { auth, database });
    registerBrowserWorkflowRoutes(application, {
      auth,
      database,
      actionPolicy,
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
  if (auth && database && xOauth)
    registerXOauthRoutes(application, { auth, database, actionPolicy, ...xOauth });
  if (auth && database && youtubeOauth)
    registerYouTubeOauthRoutes(application, { auth, database, actionPolicy, ...youtubeOauth });
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
  const shellHtml = readFileSync(resolve(uiRoot, 'index.html'), 'utf8')
    .replace('<body>', `<body data-human-auth-mode="${resolveHumanAuthMode(config)}">`)
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
  if (auth && publicAuthShells) registerPublicAuthShellRoutes(application, shellHtml);
  if (options.magicLinks && resolveHumanAuthMode(config) === 'magic_link')
    registerMagicLinkRoutes(application, options.magicLinks, {
      secureCookies: config.NODE_ENV === 'production',
    });
  registerMachineApiRoutes(application, options, actionPolicy);
  registerBrowserRoutes(application, options, actionPolicy, shellHtml);
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
