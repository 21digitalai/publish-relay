import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RuntimeConfig } from '../config/runtime-config.js';
import { registerApiDocumentationRoute } from '../modules/api/openapi.js';
import { ApiRateLimiter } from '../modules/api/rate-limit.js';
import type { AuthService } from '../modules/identity/auth.service.js';
import { registerAuthRoutes } from '../modules/identity/auth.routes.js';
import type { ApiKeyService } from '../modules/identity/api-key.service.js';
import { registerApiKeyRoutes } from '../modules/identity/api-key.routes.js';

export function createApplication(
  config: RuntimeConfig,
  auth?: AuthService,
  apiKeys?: ApiKeyService,
  uiRootOverride?: string,
): FastifyInstance {
  const application = Fastify({ logger: config.NODE_ENV !== 'test' });
  const uiRoot = uiRootOverride ?? fileURLToPath(new URL('../ui/', import.meta.url));
  const shellHtml = readFileSync(resolve(uiRoot, 'index.html'), 'utf8');

  application.register(fastifyStatic, { root: uiRoot, wildcard: false });

  application.get('/health/live', () => ({ data: { status: 'ok' }, error: null }));
  application.get('/api', () => ({ data: { name: 'Publish Relay' }, error: null }));
  registerApiDocumentationRoute(application);
  if (auth)
    registerAuthRoutes(application, auth, {
      secureCookies: config.NODE_ENV === 'production',
      shellHtml,
    });
  if (apiKeys)
    registerApiKeyRoutes(
      application,
      apiKeys,
      new ApiRateLimiter({
        workspace: 600,
        key: 300,
        mutationWorkspace: 120,
        mutationKey: 60,
        windowMs: 60_000,
      }),
    );

  return application;
}
