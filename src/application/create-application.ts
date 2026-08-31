import Fastify, { type FastifyInstance } from 'fastify';

import type { RuntimeConfig } from '../config/runtime-config.js';
import type { AuthService } from '../modules/identity/auth.service.js';
import { registerAuthRoutes } from '../modules/identity/auth.routes.js';
import type { ApiKeyService } from '../modules/identity/api-key.service.js';
import { registerApiKeyRoutes } from '../modules/identity/api-key.routes.js';

export function createApplication(
  config: RuntimeConfig,
  auth?: AuthService,
  apiKeys?: ApiKeyService,
): FastifyInstance {
  const application = Fastify({ logger: config.NODE_ENV !== 'test' });

  application.get('/health/live', () => ({ data: { status: 'ok' }, error: null }));
  application.get('/api', () => ({ data: { name: 'Publish Relay' }, error: null }));
  if (auth)
    registerAuthRoutes(application, auth, { secureCookies: config.NODE_ENV === 'production' });
  if (apiKeys) registerApiKeyRoutes(application, apiKeys);

  return application;
}
