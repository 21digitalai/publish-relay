import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { createStandaloneApplication } from '../src/application/create-application.js';

const applications = [] as ReturnType<typeof createStandaloneApplication>[];
afterEach(async () =>
  Promise.all(applications.splice(0).map((application) => application.close())),
);

function createTestApplication() {
  const application = createStandaloneApplication({
    config: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 3100,
      WORKER_POLL_INTERVAL_MS: 1000,
    },
  });
  applications.push(application);
  return application;
}

describe('agent discovery', () => {
  it('serves unauthenticated discovery without tenant or credential data', async () => {
    const application = createTestApplication();
    for (const url of [
      '/agents.txt',
      '/publish-relay-skill/SKILL.md',
      '/publish-relay-skill/publish-relay-cli.js',
      '/publish-relay-skill/manifest.json',
    ]) {
      const response = await application.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      expect(response.body).not.toMatch(/bearer [a-z0-9]{8}|pr_[a-z0-9]{8}/i);
    }
  });

  it('points agents to the live versioned OpenAPI contract', async () => {
    const application = createTestApplication();
    const discovery = await application.inject({ method: 'GET', url: '/agents.txt' });
    expect(discovery.body).toContain('API contract: /api/v1/openapi.json');
    const contract = await application.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(contract.statusCode).toBe(200);
    expect(contract.json()).toMatchObject({ openapi: '3.1.0' });
    const paths = contract.json<{
      paths: Record<string, { get?: { operationId: string }; post?: { operationId: string } }>;
    }>().paths;
    expect(paths['/api/v1/destinations/{accountId}/facebook-conversations']?.get?.operationId).toBe(
      'listFacebookPageConversations',
    );
    expect(
      paths['/api/v1/destinations/{accountId}/facebook-conversations/{conversationId}/messages']
        ?.get?.operationId,
    ).toBe('listFacebookPageConversationMessages');
    expect(
      paths['/api/v1/destinations/{accountId}/facebook-conversations/{conversationId}/messages']
        ?.post?.operationId,
    ).toBe('sendFacebookPageConversationMessage');
  });

  it('documents sparse destination overrides and authoritative effective settings', async () => {
    const application = createTestApplication();
    const skill = await application.inject({
      method: 'GET',
      url: '/publish-relay-skill/SKILL.md',
    });
    expect(skill.body).toContain('Send only per-job overrides');
    expect(skill.body).toContain('complete persisted effectiveProviderSettings snapshot');
    expect(skill.body).toContain('do not reconstruct effective settings from the sparse request');
  });

  it('publishes checksums that match the exact served assets', async () => {
    const application = createTestApplication();
    const manifest = (
      await application.inject({ method: 'GET', url: '/publish-relay-skill/manifest.json' })
    ).json<{
      data: {
        contractVersion: string;
        cliVersion: string;
        cli: { path: string; updatePolicy: string };
        assets: { path: string; sha256: string }[];
      };
    }>();
    expect(manifest.data.contractVersion).toBe('1.6.0');
    expect(manifest.data.cliVersion).toBe('1.5.0');
    const skill = await application.inject({ method: 'GET', url: '/publish-relay-skill/SKILL.md' });
    expect(skill.body).toContain('destinations list');
    expect(skill.body).toContain('publishes retry <job-id>');
    expect(skill.body).toContain('facebook-dms messages <account-id>');
    expect(skill.body).toContain('A null displayName means identity is unknown');
    expect(skill.body).toContain('facebook-dms send <account-id>');
    expect(skill.body).toContain('never use a new action ID or resend automatically');
    expect(manifest.data.cli.path).toBe('/publish-relay-skill/publish-relay-cli.js');
    expect(manifest.data.cli.updatePolicy).toBe('warn-only');
    expect(manifest.data.assets.map(({ path }) => path)).toEqual([
      '/agents.txt',
      '/publish-relay-skill/SKILL.md',
      '/publish-relay-skill/publish-relay-cli.js',
    ]);
    for (const asset of manifest.data.assets) {
      const body = (await application.inject({ method: 'GET', url: asset.path })).body;
      expect(createHash('sha256').update(body).digest('hex')).toBe(asset.sha256);
    }
  });
});
