import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
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
import type { MasterKeyProvider } from '../modules/credentials/envelope.js';
import type { XHttpClient } from '../modules/providers/x-http-client.js';
import { registerXOauthRoutes } from '../modules/providers/x-oauth.routes.js';
import { registerProviderAccountRoutes } from '../modules/credentials/provider-account.routes.js';

export function createApplication(
  config: RuntimeConfig,
  auth?: AuthService,
  apiKeys?: ApiKeyService,
  uiRootOverride?: string,
  database?: NodePgDatabase,
  xOauth?: { keys: MasterKeyProvider; client: XHttpClient; callbackUrl: string },
): FastifyInstance {
  const application = Fastify({ logger: config.NODE_ENV !== 'test' });
  const uiRoot = uiRootOverride ?? fileURLToPath(new URL('../ui/', import.meta.url));
  const shellHtml = readFileSync(resolve(uiRoot, 'index.html'), 'utf8');

  application.register(fastifyStatic, { root: uiRoot, wildcard: false });

  application.get('/health/live', () => ({ data: { status: 'ok' }, error: null }));
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
      );
    }
  }
  if (auth && database) {
    registerProviderAccountRoutes(application, { auth, database });
    registerBrowserWorkflowRoutes(application, { auth, database });
  }
  if (auth && database && xOauth) registerXOauthRoutes(application, { auth, database, ...xOauth });

  return application;
}
