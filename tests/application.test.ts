import { afterEach, describe, expect, it } from 'vitest';

import { createApplication } from '../src/application/create-application.js';

const applications = [] as ReturnType<typeof createApplication>[];
afterEach(async () =>
  Promise.all(applications.splice(0).map(async (application) => application.close())),
);

describe('application', () => {
  it('exposes process liveness without external dependencies', async () => {
    const application = createApplication({
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 3100,
      WORKER_POLL_INTERVAL_MS: 1000,
    });
    applications.push(application);
    const response = await application.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { status: 'ok' }, error: null });
  });
});
