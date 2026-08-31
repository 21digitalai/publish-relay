import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import { CursorCodec } from '../src/modules/api/contract.js';
import { registerPostRoutes } from '../src/modules/content/post.routes.js';
import type { ApiKeyService } from '../src/modules/identity/api-key.service.js';

const migrations = [
  '0000_identity_tenancy.sql',
  '0001_solid_spiral.sql',
  '0002_busy_mantis.sql',
  '0003_many_marvel_boy.sql',
  '0004_easy_doctor_spectrum.sql',
  '0005_round_thunderball.sql',
  '0006_enforce_content_workspace_foreign_keys.sql',
  '0007_add_scheduler_attempt_ledger.sql',
  '0008_handy_shen.sql',
  '0009_generalize_oauth_transaction_secret.sql',
  '0010_flashy_nextwave.sql',
  '0011_bored_grim_reaper.sql',
  '0012_enable_api_mutation_result_rls.sql',
  '0013_illegal_texas_twister.sql',
];
const workspaceId = '00000000-0000-4000-8000-000000000801';
const userId = '00000000-0000-4000-8000-000000000802';
const apiKeyId = '00000000-0000-4000-8000-000000000803';
const providerAccountId = '00000000-0000-4000-8000-000000000804';
const foreignWorkspaceId = '00000000-0000-4000-8000-000000000810';
const foreignProviderAccountId = '00000000-0000-4000-8000-000000000811';
let database: PGlite;
let application: FastifyInstance;
let apiKeys: ApiKeyService;

function requestPayload(text = 'Scheduled through the API') {
  return {
    content: { type: 'text', text },
    providerAccountIds: [providerAccountId],
    scheduledAt: '2026-09-02T10:00:00.000Z',
  };
}

beforeEach(async () => {
  database = new PGlite();
  for (const migration of migrations)
    await database.exec(
      await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'),
    );
  await database.exec(`
    INSERT INTO workspaces (id, name, slug) VALUES ('${workspaceId}', 'API Posts', 'api-posts');
    INSERT INTO users (id, display_name, email, password_hash)
      VALUES ('${userId}', 'API Owner', 'posts@example.test', 'redacted');
    SELECT set_config('app.workspace_id', '${workspaceId}', false);
    INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${workspaceId}', '${userId}', 'owner');
    INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
      VALUES ('00000000-0000-4000-8000-000000000805', '${workspaceId}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
    INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
      VALUES ('00000000-0000-4000-8000-000000000806', '${workspaceId}', 'fake', '00000000-0000-4000-8000-000000000805');
    INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, display_name)
      VALUES ('${providerAccountId}', '${workspaceId}', '00000000-0000-4000-8000-000000000806', 'one', 'One');
    INSERT INTO api_keys (id, workspace_id, created_by_user_id, label, prefix, secret_hash)
      VALUES ('${apiKeyId}', '${workspaceId}', '${userId}', 'Agent', 'pr_test', 'redacted');
    INSERT INTO workspaces (id, name, slug) VALUES ('${foreignWorkspaceId}', 'Foreign', 'foreign');
    SELECT set_config('app.workspace_id', '${foreignWorkspaceId}', false);
    INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${foreignWorkspaceId}', '${userId}', 'owner');
    INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
      VALUES ('00000000-0000-4000-8000-000000000812', '${foreignWorkspaceId}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
    INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
      VALUES ('00000000-0000-4000-8000-000000000813', '${foreignWorkspaceId}', 'fake', '00000000-0000-4000-8000-000000000812');
    INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, display_name)
      VALUES ('${foreignProviderAccountId}', '${foreignWorkspaceId}', '00000000-0000-4000-8000-000000000813', 'foreign', 'Foreign');
  `);
  apiKeys = {
    authenticate: vi.fn().mockResolvedValue({
      id: apiKeyId,
      workspaceId,
      createdByUserId: userId,
      capabilities: ['schedules:write', 'schedules:read'],
    }),
    requireCapability: vi.fn().mockResolvedValue(undefined),
  } as unknown as ApiKeyService;
  application = Fastify();
  registerPostRoutes(
    application,
    drizzle(database) as unknown as NodePgDatabase,
    apiKeys,
    new ApiRateLimiter({
      workspace: 10,
      key: 10,
      mutationWorkspace: 10,
      mutationKey: 10,
      windowMs: 60_000,
    }),
    new CursorCodec(Buffer.alloc(32, 7)),
  );
});

afterEach(async () => {
  await application.close();
  await database.close();
});

describe('POST /api/v1/posts', () => {
  it('atomically creates direct resource links and replays an identical mutation', async () => {
    const request = {
      method: 'POST' as const,
      url: '/api/v1/posts',
      headers: {
        authorization: 'Bearer pr_test.secret',
        'x-publish-relay-workspace': workspaceId,
        'idempotency-key': 'create-post-1',
      },
      payload: requestPayload(),
    };
    const created = await application.inject(request);
    const replayed = await application.inject(request);

    expect(created.statusCode).toBe(201);
    expect(replayed.statusCode).toBe(201);
    expect(replayed.headers['idempotency-replayed']).toBe('true');
    expect(replayed.json()).toEqual(created.json());
    const body = created.json<{
      data: { id: string; revisionId: string; links: { self: string; jobs: string[] } };
    }>();
    expect(body.data.links.self).toBe(`/api/v1/posts/${body.data.id}`);
    expect(body.data.links.jobs).toHaveLength(1);
    expect(body.data.links.jobs[0]).toMatch(/^\/api\/v1\/jobs\/[0-9a-f-]+$/);
    expect(body.data).not.toHaveProperty('createdByUserId');
    expect(body.data).not.toHaveProperty('content');

    const counts = await database.query<{ posts: number; jobs: number }>(
      'SELECT (SELECT count(*)::int FROM posts) AS posts, (SELECT count(*)::int FROM publication_jobs) AS jobs',
    );
    expect(counts.rows[0]).toEqual({ posts: 1, jobs: 1 });
  });

  it('returns 409 when an idempotency key is reused with a changed fingerprint', async () => {
    const headers = {
      authorization: 'Bearer pr_test.secret',
      'x-publish-relay-workspace': workspaceId,
      'idempotency-key': 'create-post-2',
    };
    expect(
      (
        await application.inject({
          method: 'POST',
          url: '/api/v1/posts',
          headers,
          payload: requestPayload(),
        })
      ).statusCode,
    ).toBe(201);
    const conflict = await application.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers,
      payload: requestPayload('Changed content'),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      success: false,
      error: { code: 'idempotency_conflict' },
    });
  });

  it('rejects a foreign-workspace account without creating partial state', async () => {
    const rejected = await application.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: {
        authorization: 'Bearer pr_test.secret',
        'x-publish-relay-workspace': workspaceId,
        'idempotency-key': 'create-post-foreign',
      },
      payload: { ...requestPayload(), providerAccountIds: [foreignProviderAccountId] },
    });
    expect(rejected.statusCode).toBe(400);
    const counts = await database.query<{ posts: number; jobs: number }>(
      `SELECT (SELECT count(*)::int FROM posts WHERE workspace_id = '${workspaceId}') AS posts,
              (SELECT count(*)::int FROM publication_jobs WHERE workspace_id = '${workspaceId}') AS jobs`,
    );
    expect(counts.rows[0]).toEqual({ posts: 0, jobs: 0 });
  });

  it('rate limits mutation requests before reserving idempotency state', async () => {
    await application.close();
    application = Fastify();
    registerPostRoutes(
      application,
      drizzle(database) as unknown as NodePgDatabase,
      apiKeys,
      new ApiRateLimiter({
        workspace: 10,
        key: 10,
        mutationWorkspace: 1,
        mutationKey: 1,
        windowMs: 60_000,
      }),
      new CursorCodec(Buffer.alloc(32, 7)),
    );
    const baseRequest = {
      method: 'POST' as const,
      url: '/api/v1/posts',
      headers: {
        authorization: 'Bearer pr_test.secret',
        'x-publish-relay-workspace': workspaceId,
      },
      payload: requestPayload(),
    };
    expect(
      (
        await application.inject({
          ...baseRequest,
          headers: { ...baseRequest.headers, 'idempotency-key': 'rate-limit-1' },
        })
      ).statusCode,
    ).toBe(201);
    const limited = await application.inject({
      ...baseRequest,
      headers: { ...baseRequest.headers, 'idempotency-key': 'rate-limit-2' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers).toMatchObject({
      'x-ratelimit-limit': '1',
      'x-ratelimit-remaining': '0',
      'retry-after': '60',
    });
    expect(limited.json()).toMatchObject({
      success: false,
      error: { code: 'rate_limit_exceeded' },
    });
  });
});

describe('GET /api/v1/posts and jobs', () => {
  it('paginates with filter-bound cursors and exposes bounded direct-resource details', async () => {
    const headers = {
      authorization: 'Bearer pr_test.secret',
      'x-publish-relay-workspace': workspaceId,
    };
    for (const [index, text] of ['First', 'Second'].entries())
      expect(
        (
          await application.inject({
            method: 'POST',
            url: '/api/v1/posts',
            headers: { ...headers, 'idempotency-key': `list-post-${String(index)}` },
            payload: requestPayload(text),
          })
        ).statusCode,
      ).toBe(201);

    const firstPage = await application.inject({
      method: 'GET',
      url: '/api/v1/posts?limit=1',
      headers,
    });
    expect(firstPage.statusCode).toBe(200);
    const page = firstPage.json<{
      data: { items: { id: string; links: { self: string } }[]; nextCursor: string };
    }>().data;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty('createdByUserId');
    expect(page.items[0]).not.toHaveProperty('content');

    expect(
      (
        await application.inject({
          method: 'GET',
          url: `/api/v1/posts?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await application.inject({ method: 'GET', url: '/api/v1/posts?cursor=malformed', headers }))
        .statusCode,
    ).toBe(400);

    const listedPost = page.items[0];
    if (!listedPost) throw new Error('Expected a post summary');
    const post = await application.inject({
      method: 'GET',
      url: listedPost.links.self,
      headers,
    });
    expect(post.statusCode).toBe(200);
    const detail = post.json<{ data: { jobs: { id: string; links: { self: string } }[] } }>().data;
    expect(detail).not.toHaveProperty('createdByUserId');
    expect(detail).not.toHaveProperty('content');
    const listedJob = detail.jobs[0];
    if (!listedJob) throw new Error('Expected a publication job');
    const job = await application.inject({
      method: 'GET',
      url: listedJob.links.self,
      headers,
    });
    expect(job.statusCode).toBe(200);
    expect(job.json<{ data: Record<string, unknown> }>().data).not.toHaveProperty(
      'providerAccountId',
    );
    expect(
      (
        await application.inject({
          method: 'GET',
          url: `/api/v1/jobs/${foreignProviderAccountId}`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
  });
});
