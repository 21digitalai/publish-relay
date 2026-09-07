import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RuntimeConfig } from '../config/runtime-config.js';
import { registerApiDocumentationRoute } from '../modules/api/openapi.js';
import { registerAgentDiscoveryRoutes } from '../modules/api/agent-discovery.js';
import { ApiRateLimiter } from '../modules/api/rate-limit.js';
import { CursorCodec } from '../modules/api/contract.js';
import type { AuthService } from '../modules/identity/auth.service.js';
import { registerAuthRoutes } from '../modules/identity/auth.routes.js';
import type { ApiKeyService } from '../modules/identity/api-key.service.js';
import { registerApiKeyRoutes } from '../modules/identity/api-key.routes.js';
import { registerPostRoutes } from '../modules/content/post.routes.js';
import { registerBrowserWorkflowRoutes } from '../modules/content/browser-workflow.routes.js';
import type { MediaStorage } from '../modules/content/media-storage.js';
import { registerMediaRoutes } from '../modules/content/media.routes.js';
import type { MasterKeyProvider } from '../modules/credentials/envelope.js';
import type { XHttpClient } from '../modules/providers/x-http-client.js';
import { registerXOauthRoutes } from '../modules/providers/x-oauth.routes.js';
import { registerProviderAccountRoutes } from '../modules/credentials/provider-account.routes.js';
import { allowAllActionPolicy, type ActionPolicy } from '../modules/policy/action-policy.js';

export function createApplication(
  config: RuntimeConfig,
  auth?: AuthService,
  apiKeys?: ApiKeyService,
  uiRootOverride?: string,
  database?: NodePgDatabase,
  xOauth?: { keys: MasterKeyProvider; client: XHttpClient; callbackUrl: string },
  mediaStorage?: MediaStorage,
  actionPolicy: ActionPolicy = allowAllActionPolicy,
): FastifyInstance {
  const application = Fastify({ logger: config.NODE_ENV !== 'test' });
  const uiRoot = uiRootOverride ?? fileURLToPath(new URL('../ui/', import.meta.url));
  const shellHtml = readFileSync(resolve(uiRoot, 'index.html'), 'utf8');

  application.register(fastifyStatic, { root: uiRoot, wildcard: false });

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
      '',
    ].join('\n');
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(body);
  });
  application.get('/api', () => ({ data: { name: 'Publish Relay' }, error: null }));
  registerApiDocumentationRoute(application);
  registerAgentDiscoveryRoutes(application);
  if (auth)
    registerAuthRoutes(application, auth, {
      secureCookies: config.NODE_ENV === 'production',
      shellHtml,
    });
  if (apiKeys) {
    const rateLimiter = new ApiRateLimiter({
      workspace: 600,
      key: 300,
      mutationWorkspace: 120,
      mutationKey: 60,
      windowMs: 60_000,
    });
    registerApiKeyRoutes(application, apiKeys, rateLimiter);
    if (database) {
      if (!config.CURSOR_SIGNING_SECRET)
        throw new Error('CURSOR_SIGNING_SECRET is required for API routes');
      registerPostRoutes(
        application,
        database,
        apiKeys,
        rateLimiter,
        new CursorCodec(Buffer.from(config.CURSOR_SIGNING_SECRET)),
        actionPolicy,
      );
      if (mediaStorage)
        registerMediaRoutes(
          application,
          database,
          mediaStorage,
          apiKeys,
          rateLimiter,
          actionPolicy,
        );
    }
  }
  if (auth && database) {
    registerProviderAccountRoutes(application, { auth, database });
    registerBrowserWorkflowRoutes(application, {
      auth,
      database,
      actionPolicy,
      ...(mediaStorage ? { mediaStorage } : {}),
    });
  }
  if (auth && database && xOauth)
    registerXOauthRoutes(application, { auth, database, actionPolicy, ...xOauth });

  return application;
}
