import Fastify, { type FastifyInstance } from 'fastify';

import type { RuntimeConfig } from '../config/runtime-config.js';

export function createApplication(config: RuntimeConfig): FastifyInstance {
  const application = Fastify({ logger: config.NODE_ENV !== 'test' });

  application.get('/health/live', () => ({ data: { status: 'ok' }, error: null }));
  application.get('/api', () => ({ data: { name: 'Publish Relay' }, error: null }));

  return application;
}
