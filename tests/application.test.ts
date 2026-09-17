import { afterEach, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import {
  createStandaloneApplication,
  registerCoreApplication,
} from '../src/application/create-application.js';

const testConfig = {
  NODE_ENV: 'test' as const,
  HOST: '127.0.0.1',
  PORT: 3100,
  WORKER_POLL_INTERVAL_MS: 1000,
};
const applications = [] as ReturnType<typeof createStandaloneApplication>[];
afterEach(async () =>
  Promise.all(applications.splice(0).map(async (application) => application.close())),
);

describe('application', () => {
  it('exposes process liveness without external dependencies', async () => {
    const application = createStandaloneApplication({ config: testConfig });
    applications.push(application);
    const response = await application.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { status: 'ok' }, error: null });
  });

  it('fails readiness when the database is not configured', async () => {
    const application = createStandaloneApplication({ config: testConfig });
    applications.push(application);
    const response = await application.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ data: null, error: 'Database is not configured' });
  });

  it('exposes bounded process metrics without application data', async () => {
    const application = createStandaloneApplication({ config: testConfig });
    applications.push(application);
    const response = await application.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('publish_relay_process_uptime_seconds');
    expect(response.body).toContain('publish_relay_process_resident_memory_bytes');
    expect(response.body).toMatch(/^publish_relay_process_uptime_seconds \d+(?:\.\d+)?$/m);
    expect(response.body).toMatch(/^publish_relay_process_resident_memory_bytes \d+$/m);
    expect(response.body).not.toMatch(/(?:NaN|Infinity)/);
    expect(response.body).not.toContain('DATABASE_URL');
  });

  it('registers Core into a caller-owned Fastify process without public auth shells', async () => {
    const application = Fastify();
    registerCoreApplication(application, { config: testConfig });
    applications.push(application);

    expect((await application.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    expect((await application.inject({ method: 'GET', url: '/login' })).statusCode).toBe(404);
  });

  it('fails closed when Core routes are registered twice', () => {
    const application = Fastify();
    applications.push(application);
    registerCoreApplication(application, { config: testConfig });

    expect(() => registerCoreApplication(application, { config: testConfig })).toThrow(
      /already declared|duplicate/i,
    );
  });
});
