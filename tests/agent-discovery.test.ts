import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { createApplication } from '../src/application/create-application.js';

const applications = [] as ReturnType<typeof createApplication>[];
afterEach(async () =>
  Promise.all(applications.splice(0).map((application) => application.close())),
);

function createTestApplication() {
  const application = createApplication({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 3100,
    WORKER_POLL_INTERVAL_MS: 1000,
  });
  applications.push(application);
  return application;
}

describe('agent discovery', () => {
  it('serves unauthenticated discovery without tenant or credential data', async () => {
    const application = createTestApplication();
    for (const url of ['/agents.txt', '/publish-relay-skill/SKILL.md']) {
      const response = await application.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      expect(response.body).not.toMatch(/api[_-]?key|bearer [a-z0-9]|workspaceId/i);
    }
  });

  it('publishes checksums that match the exact served assets', async () => {
    const application = createTestApplication();
    const manifest = (
      await application.inject({ method: 'GET', url: '/publish-relay-skill/manifest.json' })
    ).json<{
      data: {
        cli: { updatePolicy: string };
        assets: { path: string; sha256: string }[];
      };
    }>();
    expect(manifest.data.cli.updatePolicy).toBe('warn-only');
    for (const asset of manifest.data.assets) {
      const body = (await application.inject({ method: 'GET', url: asset.path })).body;
      expect(createHash('sha256').update(body).digest('hex')).toBe(asset.sha256);
    }
  });
});
