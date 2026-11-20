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

  it('omits disabled provider media and connection routes from a composed server', () => {
    const application = Fastify();
    registerCoreApplication(application, {
      config: {
        ...testConfig,
        CURSOR_SIGNING_SECRET: 'a'.repeat(32),
        PUBLISH_RELAY_ENABLED_ADAPTERS: '',
      },
      database: {} as never,
      mediaStorage: {} as never,
      auth: {} as never,
    });
    applications.push(application);

    expect(application.hasRoute({ method: 'GET', url: '/provider-media/instagram' })).toBe(false);
    expect(
      application.hasRoute({ method: 'GET', url: '/provider-media/tiktok/:grant/:token' }),
    ).toBe(false);
    expect(application.hasRoute({ method: 'POST', url: '/api/oauth/instagram' })).toBe(false);
  });

  it('keeps a Hosted root while serving one magic-link auth shell and prefixed assets', async () => {
    const application = Fastify();
    application.get('/', () => 'Hosted landing');
    registerCoreApplication(application, {
      config: { ...testConfig, PUBLISH_RELAY_HUMAN_AUTH_MODE: 'magic_link' },
      auth: {} as never,
      publicAuthShells: true,
      uiPrefix: '/core-assets/',
    });
    applications.push(application);

    expect((await application.inject({ method: 'GET', url: '/' })).body).toBe('Hosted landing');
    const login = await application.inject({ method: 'GET', url: '/login' });
    const register = await application.inject({ method: 'GET', url: '/register' });
    expect(login.statusCode).toBe(200);
    expect(login.body).toBe(register.body);
    expect(login.body).toContain('data-human-auth-mode="magic_link"');
    expect(login.body).toContain('rel="icon" type="image/svg+xml" href="/core-assets/favicon.svg"');
    const favicon = await application.inject({ method: 'GET', url: '/core-assets/favicon.svg' });
    expect(favicon.statusCode).toBe(200);
    expect(favicon.headers['content-type']).toContain('image/svg+xml');
    expect(favicon.body).toContain('viewBox="0 0 32 32"');
    expect(
      (await application.inject({ method: 'GET', url: '/core-assets/index.html' })).statusCode,
    ).toBe(200);
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
