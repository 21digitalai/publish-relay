import Fastify, { type FastifyInstance } from 'fastify';

import type { RuntimeConfig } from '../config/runtime-config.js';
import type { AuthService } from '../modules/identity/auth.service.js';
import { registerAuthRoutes } from '../modules/identity/auth.routes.js';

export function createApplication(config: RuntimeConfig, auth?: AuthService): FastifyInstance {
  const application = Fastify({ logger: config.NODE_ENV !== 'test' });

  application.get('/health/live', () => ({ data: { status: 'ok' }, error: null }));
  application.get('/api', () => ({ data: { name: 'Publish Relay' }, error: null }));
  if (auth)
    registerAuthRoutes(application, auth, { secureCookies: config.NODE_ENV === 'production' });

  return application;
}
