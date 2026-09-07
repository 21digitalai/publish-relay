import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { registerApiKeyRoutes } from '../src/modules/identity/api-key.routes.js';
import type { ApiKeyService } from '../src/modules/identity/api-key.service.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () =>
  Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        ),
    ),
  ),
);

async function fixture(status: number, body: unknown, workspace = 'workspace-one') {
  const server = createServer((request, response) => {
    if (request.headers['x-publish-relay-workspace'] !== workspace) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          success: false,
          error: { code: 'authentication_required', message: 'Workspace header required' },
        }),
      );
      return;
    }
    const payload =
      request.url === '/api/v1/account'
        ? {
            success: true,
            data: {
              id: 'key-1',
              workspaceId: workspace,
              workspaceLabel: 'Atlas',
              prefix: 'pr_public',
              capabilities: ['schedules:read'],
              expiresAt: null,
            },
            meta: { requestId: 'preflight' },
          }
        : body;
    response.writeHead(request.url === '/api/v1/account' ? 200 : status, {
      'content-type': 'application/json',
    });
    response.end(JSON.stringify(payload));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return `http://127.0.0.1:${String(address.port)}`;
}

async function cli(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/entrypoints/cli.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, PUBLISH_RELAY_WORKSPACE: 'workspace-one', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (value) => {
      stdout += String(value);
    });
    child.stderr.on('data', (value) => {
      stderr += String(value);
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe('Publish Relay CLI', () => {
  it('matches the real account API authentication and response contract', async () => {
    const application = Fastify();
    registerApiKeyRoutes(application, {
      authenticate: (workspaceId: string, secret: string) => {
        expect(workspaceId).toBe('workspace-one');
        expect(secret).toBe('test-key');
        return Promise.resolve({
          id: '00000000-0000-4000-8000-000000000001',
          workspaceId,
          createdByUserId: 'user-1',
          workspaceLabel: 'Atlas',
          prefix: 'pr_public',
          capabilities: ['schedules:read'],
          expiresAt: null,
        });
      },
    } as unknown as ApiKeyService);
    await application.listen({ host: '127.0.0.1', port: 0 });
    servers.push(application.server);
    const address = application.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');

    const result = await cli(
      ['account', 'current', '--base-url', `http://127.0.0.1:${String(address.port)}`],
      { PUBLISH_RELAY_API_KEY: 'test-key' },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      data: {
        id: '00000000-0000-4000-8000-000000000001',
        workspaceId: 'workspace-one',
        workspaceLabel: 'Atlas',
        prefix: 'pr_public',
        capabilities: ['schedules:read'],
        expiresAt: null,
      },
    });
  });

  it.each([
    [401, 3],
    [403, 4],
    [400, 5],
    [404, 5],
    [422, 5],
    [409, 6],
    [429, 7],
    [500, 8],
    [424, 9],
  ])('maps HTTP %i to stable exit %i while redacting the envelope', async (status, exit) => {
    const body = {
      success: false,
      error: {
        code: `error_${String(status)}`,
        message: 'safe',
        requestId: 'request-1',
        details: { accessToken: 'provider-secret', reason: 'private provider response' },
      },
    };
    const baseUrl = await fixture(status, body);
    const result = await cli(['posts', 'show', 'post-1', '--base-url', baseUrl], {
      PUBLISH_RELAY_API_KEY: 'test-key',
    });
    expect(result.code).toBe(exit);
    expect(JSON.parse(result.stdout)).toEqual({
      success: false,
      error: {
        code: `error_${String(status)}`,
        message: 'safe',
        requestId: 'request-1',
        details: { accessToken: '[REDACTED]', reason: '[REDACTED]' },
      },
    });
    expect(result.stdout).not.toContain('test-key');
    expect(result.stdout).not.toContain('provider-secret');
    expect(result.stdout).not.toContain('private provider response');
  });

  it('redacts nested success fields while preserving durable IDs and direct links', async () => {
    const baseUrl = await fixture(200, {
      success: true,
      data: {
        id: 'job-1',
        state: 'published',
        providerToken: 'provider-secret',
        nested: { password: 'credential' },
        createdAt: '2026-08-31T21:00:00.000Z',
        updatedAt: '2026-08-31T21:01:00.000Z',
        scheduledAt: '2026-08-31T21:02:00.000Z',
        links: { self: '/api/v1/jobs/job-1', post: '/api/v1/posts/post-1' },
      },
      meta: { requestId: 'request-success', internalTrace: 'private-trace' },
    });
    const result = await cli(['publishes', 'show', 'job-1', '--base-url', baseUrl], {
      PUBLISH_RELAY_API_KEY: 'test-key',
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      data: {
        id: 'job-1',
        state: 'published',
        providerToken: '[REDACTED]',
        nested: '[REDACTED]',
        createdAt: '2026-08-31T21:00:00.000Z',
        updatedAt: '2026-08-31T21:01:00.000Z',
        scheduledAt: '2026-08-31T21:02:00.000Z',
        links: { self: '/api/v1/jobs/job-1', post: '/api/v1/posts/post-1' },
      },
      meta: { requestId: 'request-success', internalTrace: '[REDACTED]' },
    });
    expect(result.stdout).not.toContain('provider-secret');
    expect(result.stdout).not.toContain('credential');
    expect(result.stdout).not.toContain('private-trace');
  });

  it('preserves the posts list contract while redacting injected nested fields', async () => {
    const baseUrl = await fixture(200, {
      success: true,
      data: {
        items: [
          {
            id: 'post-1',
            createdAt: '2026-08-31T21:00:00.000Z',
            updatedAt: '2026-08-31T21:01:00.000Z',
            links: { self: '/api/v1/posts/post-1', providerConsole: 'private-url' },
            accessToken: 'provider-secret',
          },
        ],
        nextCursor: 'cursor-1',
      },
      meta: { requestId: 'request-list' },
    });
    const result = await cli(['posts', 'list', '--base-url', baseUrl], {
      PUBLISH_RELAY_API_KEY: 'test-key',
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      data: {
        items: [
          {
            id: 'post-1',
            createdAt: '2026-08-31T21:00:00.000Z',
            updatedAt: '2026-08-31T21:01:00.000Z',
            links: { self: '/api/v1/posts/post-1', providerConsole: '[REDACTED]' },
            accessToken: '[REDACTED]',
          },
        ],
        nextCursor: 'cursor-1',
      },
      meta: { requestId: 'request-list' },
    });
  });

  it('preserves the post detail contract including nested job links', async () => {
    const baseUrl = await fixture(200, {
      success: true,
      data: {
        id: 'post-1',
        revisionId: 'revision-1',
        revisionNumber: 2,
        createdAt: '2026-08-31T21:00:00.000Z',
        updatedAt: '2026-08-31T21:01:00.000Z',
        links: { self: '/api/v1/posts/post-1' },
        jobs: [
          {
            id: 'job-1',
            state: 'queued',
            scheduledAt: '2026-08-31T21:02:00.000Z',
            links: { self: '/api/v1/jobs/job-1' },
            providerToken: 'provider-secret',
          },
        ],
      },
      meta: { requestId: 'request-detail' },
    });
    const result = await cli(['posts', 'show', 'post-1', '--base-url', baseUrl], {
      PUBLISH_RELAY_API_KEY: 'test-key',
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: {
        revisionNumber: 2,
        links: { self: '/api/v1/posts/post-1' },
        jobs: [
          {
            id: 'job-1',
            state: 'queued',
            scheduledAt: '2026-08-31T21:02:00.000Z',
            links: { self: '/api/v1/jobs/job-1' },
            providerToken: '[REDACTED]',
          },
        ],
      },
    });
  });

  it('preflights workspace before a mutation and sends body plus idempotency key', async () => {
    const baseUrl = await fixture(201, {
      success: true,
      data: {
        id: 'post-1',
        revisionId: 'revision-1',
        links: { self: '/api/v1/posts/post-1', jobs: ['/api/v1/jobs/job-1'] },
      },
      meta: { requestId: 'request-2' },
    });
    const directory = await mkdtemp(join(tmpdir(), 'publish-relay-cli-'));
    const bodyFile = join(directory, 'body.json');
    await writeFile(bodyFile, '{"content":{"type":"text","text":"hello"}}');
    const result = await cli(
      [
        'posts',
        'create',
        '--base-url',
        baseUrl,
        '--require-workspace',
        'workspace-one',
        '--idempotency-key',
        'idem-1',
        '--body-file',
        bodyFile,
      ],
      { PUBLISH_RELAY_API_KEY: 'test-key' },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      data: {
        id: 'post-1',
        revisionId: 'revision-1',
        links: { self: '/api/v1/posts/post-1', jobs: ['/api/v1/jobs/job-1'] },
      },
    });
  });

  it('rejects secret-bearing profile fields before making a request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'publish-relay-cli-profile-'));
    const profile = join(directory, 'profile.json');
    await writeFile(profile, '{"baseUrl":"https://example.invalid","apiKey":"secret"}');
    const result = await cli(['health', '--profile-file', profile]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('may not contain secret material');
  });

  it('rejects secret-bearing command-line flags', async () => {
    const result = await cli(['health', '--api-key', 'secret']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('load secrets from the environment');
  });

  it('does not advertise commands without a live API contract', async () => {
    const result = await cli(['destinations', 'list']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown command destinations list');
  });

  it('returns exit 10 and the durable job ID when bounded polling times out', async () => {
    const baseUrl = await fixture(200, {
      success: true,
      data: { id: 'job-1', state: 'dispatching' },
      meta: { requestId: 'request-3' },
    });
    const result = await cli(
      [
        'publishes',
        'poll',
        'job-1',
        '--base-url',
        baseUrl,
        '--poll-timeout-ms',
        '20',
        '--poll-interval-ms',
        '5',
      ],
      { PUBLISH_RELAY_API_KEY: 'test-key' },
    );
    expect(result.code).toBe(10);
    expect(JSON.parse(result.stdout)).toMatchObject({
      jobId: 'job-1',
      links: { job: '/api/v1/jobs/job-1' },
    });
  });

  it('preserves the full effective YouTube settings snapshot when polling completes', async () => {
    const effectiveProviderSettings = {
      schemaVersion: 1,
      title: 'Scheduled clip',
      privacyStatus: 'public',
      madeForKids: false,
      notifySubscribers: true,
    };
    const baseUrl = await fixture(200, {
      success: true,
      data: { id: 'job-1', state: 'published', effectiveProviderSettings },
      meta: { requestId: 'request-4' },
    });
    const result = await cli(
      ['publishes', 'poll', 'job-1', '--base-url', baseUrl, '--poll-timeout-ms', '100'],
      { PUBLISH_RELAY_API_KEY: 'test-key' },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { id: 'job-1', effectiveProviderSettings },
    });
  });
});
