import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import cookie from '@fastify/cookie';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import { CursorCodec } from '../src/modules/api/contract.js';
import { registerPostRoutes } from '../src/modules/content/post.routes.js';
import { buildMachineJobListQuery } from '../src/modules/content/post-read.repository.js';
import { registerMediaRoutes } from '../src/modules/content/media.routes.js';
import type { MediaStorage } from '../src/modules/content/media-storage.js';
import { registerBrowserWorkflowRoutes } from '../src/modules/content/browser-workflow.routes.js';
import { registerExternalDraftRoutes } from '../src/modules/content/external-draft.routes.js';
import { disconnectProviderAccount } from '../src/modules/credentials/provider-account.service.js';
import { registerApiKeyRoutes } from '../src/modules/identity/api-key.routes.js';
import { ApiKeyAuthorizationError } from '../src/modules/identity/api-key.service.js';
import type { ApiKeyService } from '../src/modules/identity/api-key.service.js';
import type { AuthService } from '../src/modules/identity/auth.service.js';
import type { DelegatedAuthorizationService } from '../src/modules/delegated-authorization/delegated-authorization.service.js';
import type { ActionPolicy } from '../src/modules/policy/action-policy.js';

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
  '0014_great_lethal_legion.sql',
  '0015_talented_alex_power.sql',
  '0016_common_barracuda.sql',
  '0017_dark_whizzer.sql',
  '0018_membership_identity_scope.sql',
  '0019_media_retention_lifecycle.sql',
  '0022_truthful_post_actors.sql',
  '0024_mp4_media_metadata.sql',
  '0025_lucky_legion.sql',
  '0026_parallel_human_cannonball.sql',
  '0027_overjoyed_dark_beast.sql',
  '0028_nosy_dracula.sql',
  '0029_handy_human_fly.sql',
  '0030_delegated_token_resolution.sql',
  '0031_graceful_photon.sql',
  '0032_little_stellaris.sql',
  '0034_simple_jamie_braddock.sql',
  '0035_delegated_account_receipt.sql',
  '0042_long_pepper_potts.sql',
  '0045_meta_destination_foundation.sql',
  '0046_linkedin_connection_expiry.sql',
  '0047_linkedin_member_connections.sql',
  '0048_reconcile_linkedin_connections.sql',
  '0049_meta_effective_payload.sql',
  '0051_provider_subject_lifecycle.sql',
  '0055_x_long_post_declaration.sql',
  '0056_meta_grant_family.sql',
  '0058_workspace_tombstone.sql',
  '0059_provider_account_exposures.sql',
  '0060_facebook_page_exposure_edit.sql',
  '0061_cross_workspace_account_job_guard.sql',
  '0062_exposed_account_admission.sql',
  '0064_exposed_machine_admission.sql',
  '0067_browser_shared_page_job_account.sql',
  '0068_browser_shared_page_machine_job_read.sql',
  '0077_publication_attempt_external_url.sql',
  '0114_publication_approval_hold.sql',
];
const workspaceId = '00000000-0000-4000-8000-000000000801';
const userId = '00000000-0000-4000-8000-000000000802';
const apiKeyId = '00000000-0000-4000-8000-000000000803';
const delegatedGrantId = '00000000-0000-4000-8000-000000000809';
const providerAccountId = '00000000-0000-4000-8000-000000000804';
const foreignWorkspaceId = '00000000-0000-4000-8000-000000000810';
const foreignProviderAccountId = '00000000-0000-4000-8000-000000000811';
const foreignPostId = '00000000-0000-4000-8000-000000000814';
const foreignRevisionId = '00000000-0000-4000-8000-000000000815';
const foreignJobId = '00000000-0000-4000-8000-000000000816';
const foreignMediaId = '00000000-0000-4000-8000-000000000817';
const foreignDraftId = '00000000-0000-4000-8000-000000000818';
const missingResourceId = '00000000-0000-4000-8000-000000000899';
let database: PGlite;
let application: FastifyInstance;
let apiKeys: ApiKeyService;
let authenticate: ReturnType<typeof vi.fn>;
let browserAuthenticate: ReturnType<typeof vi.fn>;
let requireCapability: ReturnType<typeof vi.fn>;
let authenticateDelegated: ReturnType<typeof vi.fn>;
let evaluateAction: ActionPolicy['evaluate'];
let enabledAdapters: Set<string>;
let browserNow: Date | undefined;
let mediaPutError: Error | undefined;
const temporaryDirectories: string[] = [];
const storedMedia = new Map<string, Buffer>();
const mediaStorage: MediaStorage = {
  put: (input) => {
    if (mediaPutError) return Promise.reject(mediaPutError);
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const storageKey = `${input.workspaceId}/${input.mediaId}/${sha256}`;
    storedMedia.set(storageKey, Buffer.from(input.bytes));
    return Promise.resolve({ storageKey });
  },
  read: (storageKey) => Promise.resolve(Buffer.from(storedMedia.get(storageKey) ?? [])),
  delete: (storageKey) => {
    storedMedia.delete(storageKey);
    return Promise.resolve();
  },
};

async function runCli(args: string[], apiKey = 'pr_test.secret') {
  if (!application.server.listening) await application.listen({ host: '127.0.0.1', port: 0 });
  const address = application.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing application address');
  return new Promise<{ code: number; body: Record<string, unknown>; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/entrypoints/cli.ts',
          ...args,
          '--base-url',
          `http://127.0.0.1:${String(address.port)}`,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PUBLISH_RELAY_API_KEY: apiKey,
            PUBLISH_RELAY_WORKSPACE: workspaceId,
          },
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (value) => (stdout += String(value)));
      child.stderr.on('data', (value) => (stderr += String(value)));
      child.on('error', reject);
      child.on('close', (code) => {
        if (!stdout.trim()) {
          reject(new Error(`CLI exited without JSON output (code ${String(code)}): ${stderr}`));
          return;
        }
        try {
          resolve({
            code: code ?? -1,
            body: JSON.parse(stdout) as Record<string, unknown>,
            stderr,
          });
        } catch (error) {
          reject(new Error(`CLI emitted invalid JSON: ${stdout}`, { cause: error }));
        }
      });
    },
  );
}

function stableEnvelope(body: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(body);
  const meta = copy.meta as Record<string, unknown> | undefined;
  if (meta) delete meta.requestId;
  const error = copy.error as Record<string, unknown> | undefined;
  if (error) delete error.requestId;
  return copy;
}

function requestPayload(text = 'Scheduled through the API') {
  return {
    content: { type: 'text', text },
    providerAccountIds: [providerAccountId],
    scheduledAt: '2026-09-02T10:00:00.000Z',
  };
}

beforeEach(async () => {
  storedMedia.clear();
  mediaPutError = undefined;
  enabledAdapters = new Set([
    'fake',
    'x',
    'youtube',
    'instagram',
    'facebook_page',
    'linkedin',
    'tiktok',
    'snapchat',
    'fanvue',
  ]);
  browserNow = new Date('2026-09-01T10:00:00.000Z');
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
    INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, remote_account_id, destination_provider, display_name)
      VALUES ('${providerAccountId}', '${workspaceId}', '00000000-0000-4000-8000-000000000806', 'one', 'one', 'fake', 'One');
    INSERT INTO api_keys (id, workspace_id, created_by_user_id, label, prefix, secret_hash)
      VALUES ('${apiKeyId}', '${workspaceId}', '${userId}', 'Agent', 'pr_test', 'redacted');
    INSERT INTO workspaces (id, name, slug) VALUES ('${foreignWorkspaceId}', 'Foreign', 'foreign');
    SELECT set_config('app.workspace_id', '${foreignWorkspaceId}', false);
    INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${foreignWorkspaceId}', '${userId}', 'owner');
    INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
      VALUES ('00000000-0000-4000-8000-000000000812', '${foreignWorkspaceId}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
    INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
      VALUES ('00000000-0000-4000-8000-000000000813', '${foreignWorkspaceId}', 'fake', '00000000-0000-4000-8000-000000000812');
    INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, remote_account_id, destination_provider, display_name)
      VALUES ('${foreignProviderAccountId}', '${foreignWorkspaceId}', '00000000-0000-4000-8000-000000000813', 'foreign', 'foreign', 'fake', 'Foreign');
    INSERT INTO posts (id, workspace_id, created_by_user_id)
      VALUES ('${foreignPostId}', '${foreignWorkspaceId}', '${userId}');
    INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
      VALUES ('${foreignRevisionId}', '${foreignWorkspaceId}', '${foreignPostId}', 1, '{"type":"text","text":"Foreign tenant secret"}');
    INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at)
      VALUES ('${foreignJobId}', '${foreignWorkspaceId}', '${foreignPostId}', '${foreignRevisionId}', '${foreignProviderAccountId}', now());
    INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
      VALUES ('${foreignMediaId}', '${foreignWorkspaceId}', 'foreign.jpg', 'foreign-hash', 'image/jpeg', 10, 'ready');
    INSERT INTO external_drafts
      (id, workspace_id, source_actor_type, source_actor_id, external_id, request_fingerprint)
      VALUES ('${foreignDraftId}', '${foreignWorkspaceId}', 'api_key', '${apiKeyId}', 'foreign-draft', 'foreign-fingerprint');
    INSERT INTO external_draft_media (workspace_id, draft_id, media_id, position)
      VALUES ('${foreignWorkspaceId}', '${foreignDraftId}', '${foreignMediaId}', 0);
    SELECT set_config('app.workspace_id', '${workspaceId}', false);
  `);
  authenticate = vi.fn().mockResolvedValue({
    id: apiKeyId,
    workspaceId,
    createdByUserId: userId,
    capabilities: ['schedules:write', 'schedules:read'],
  });
  requireCapability = vi.fn().mockResolvedValue(undefined);
  authenticateDelegated = vi.fn().mockResolvedValue(null);
  evaluateAction = vi.fn<ActionPolicy['evaluate']>().mockResolvedValue({ allowed: true });
  browserAuthenticate = vi.fn().mockResolvedValue({ workspaceId, userId, role: 'owner' });
  apiKeys = { authenticate, requireCapability } as unknown as ApiKeyService;
  const delegatedAuthorization = {
    authenticate: authenticateDelegated,
  } as unknown as DelegatedAuthorizationService;
  application = Fastify();
  application.register(cookie);
  registerApiKeyRoutes(application, apiKeys);
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
    { evaluate: evaluateAction },
    delegatedAuthorization,
    enabledAdapters,
  );
  registerMediaRoutes(
    application,
    drizzle(database) as unknown as NodePgDatabase,
    mediaStorage,
    apiKeys,
    new ApiRateLimiter({
      workspace: 10,
      key: 10,
      mutationWorkspace: 10,
      mutationKey: 10,
      windowMs: 60_000,
    }),
    undefined,
    undefined,
    undefined,
    delegatedAuthorization,
  );
  registerExternalDraftRoutes(
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
    delegatedAuthorization,
  );
  registerBrowserWorkflowRoutes(application, {
    database: drizzle(database) as unknown as NodePgDatabase,
    now: () => browserNow ?? new Date(),
    auth: {
      authenticate: browserAuthenticate,
    } as unknown as AuthService,
    mediaStorage,
  });
});

describe('external draft PostgreSQL route boundary', () => {
  const localMediaId = '00000000-0000-4000-8000-000000000819';
  const headers = {
    authorization: 'Bearer pr_test.secret',
    'x-publish-relay-workspace': workspaceId,
    'content-type': 'application/json',
  };

  beforeEach(async () => {
    await database.exec(`
      SELECT set_config('app.workspace_id', '${workspaceId}', false);
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
        VALUES ('${localMediaId}', '${workspaceId}', 'local.jpg', 'local-hash', 'image/jpeg', 10, 'ready');
    `);
  });

  it('serializes concurrent POST replay and returns one durable draft aggregate', async () => {
    const request = {
      method: 'POST' as const,
      url: '/api/v1/drafts',
      headers: { ...headers, 'idempotency-key': 'concurrent-draft-create' },
      payload: { externalId: 'clip-concurrent', mediaIds: [localMediaId], label: 'Clip' },
    };
    const [first, second] = await Promise.all([
      application.inject(request),
      application.inject(request),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 201]);
    expect([
      first.headers['idempotency-replayed'],
      second.headers['idempotency-replayed'],
    ]).toContain('true');
    const firstBody = first.json<{ data: { id: string; links: { self: string } } }>();
    const secondBody = second.json<{ data: { id: string; links: { self: string } } }>();
    expect(secondBody.data).toEqual(firstBody.data);

    const drafts = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM external_drafts
      WHERE workspace_id = '${workspaceId}' AND external_id = 'clip-concurrent'
    `);
    const attachments = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM external_draft_media
      WHERE workspace_id = '${workspaceId}' AND draft_id = '${firstBody.data.id}'
    `);
    expect(drafts.rows[0]?.count).toBe(1);
    expect(attachments.rows[0]?.count).toBe(1);

    const detail = await application.inject({
      method: 'GET',
      url: firstBody.data.links.self,
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      data: { id: firstBody.data.id, mediaIds: [localMediaId] },
    });
  });

  it('safe-hides foreign drafts and rejects foreign media without leaking tenant data', async () => {
    const detail = await application.inject({
      method: 'GET',
      url: `/api/v1/drafts/${foreignDraftId}`,
      headers,
    });
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toMatchObject({ error: { code: 'not_found' } });
    expect(JSON.stringify(detail.json())).not.toContain('foreign-draft');

    const create = await application.inject({
      method: 'POST',
      url: '/api/v1/drafts',
      headers: { ...headers, 'idempotency-key': 'foreign-media-draft' },
      payload: { externalId: 'foreign-media-attempt', mediaIds: [foreignMediaId] },
    });
    expect(create.statusCode).toBe(400);
    expect(create.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(JSON.stringify(create.json())).not.toContain('foreign');
    const rows = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM external_drafts
      WHERE workspace_id = '${workspaceId}' AND external_id = 'foreign-media-attempt'
    `);
    expect(rows.rows[0]?.count).toBe(0);
  });
});

describe('agent media upload PostgreSQL boundary', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const headers = {
    authorization: 'Bearer pr_test.secret',
    'x-publish-relay-workspace': workspaceId,
    'content-type': 'image/png',
    'x-file-name': 'daily-vibe.png',
    'idempotency-key': 'media-upload-1',
  };

  it('uploads and replays media through delegated content scope with actor isolation', async () => {
    authenticate.mockResolvedValue(null);
    authenticateDelegated.mockResolvedValue({
      grantId: delegatedGrantId,
      workspaceId,
      userId,
      clientId: 'example-client-local',
      scopes: ['content:write'],
    });
    const delegatedHeaders = {
      ...headers,
      authorization: 'Bearer delegated-token',
      'idempotency-key': 'delegated-media-upload',
    };
    const created = await application.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: delegatedHeaders,
      payload: png,
    });
    const replayed = await application.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: delegatedHeaders,
      payload: png,
    });
    expect(created.statusCode).toBe(201);
    expect(replayed.headers['idempotency-replayed']).toBe('true');
    const mutation = await database.query<{ actor_type: string; actor_id: string }>(`
      SELECT actor_type, actor_id FROM api_mutation_results
      WHERE idempotency_key = 'delegated-media-upload'
    `);
    expect(mutation.rows).toEqual([{ actor_type: 'delegated', actor_id: delegatedGrantId }]);

    authenticateDelegated.mockResolvedValueOnce({
      grantId: delegatedGrantId,
      workspaceId,
      userId,
      clientId: 'example-client-local',
      scopes: ['destinations:read'],
    });
    const denied = await application.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { ...delegatedHeaders, 'idempotency-key': 'delegated-media-denied' },
      payload: png,
    });
    expect(denied.statusCode).toBe(403);
  });

  it('stores exact bytes once, replays identity, conflicts on changed bytes, and feeds post creation', async () => {
    const first = await application.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers,
      payload: png,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{
      data: { id: string; mimeType: string; sha256: string; byteSize: number; state: string };
    }>();
    expect(firstBody.data).toMatchObject({
      mimeType: 'image/png',
      byteSize: png.length,
      state: 'ready',
    });
    expect(storedMedia.size).toBe(1);

    const replay = await application.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers,
      payload: png,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<{ data: { id: string } }>().data.id).toBe(firstBody.data.id);
    expect(storedMedia.size).toBe(1);

    const conflict = await application.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers,
      payload: Buffer.concat([png, Buffer.from([2])]),
    });
    expect(conflict.statusCode).toBe(409);
    expect(storedMedia.size).toBe(1);

    const post = await application.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: {
        authorization: headers.authorization,
        'x-publish-relay-workspace': workspaceId,
        'content-type': 'application/json',
        'idempotency-key': 'post-with-uploaded-media',
      },
      payload: { ...requestPayload(), mediaIds: [firstBody.data.id] },
    });
    expect(post.statusCode).toBe(201);
    const jobLink = post.json<{ data: { links: { jobs: string[] } } }>().data.links.jobs[0];
    const jobId = jobLink?.split('/').at(-1);
    expect(jobId).toBeTruthy();
    if (!jobId) throw new Error('Expected a created job link');
    const browserHeaders = { cookie: `publish_relay_session=${workspaceId}.browser-token` };
    const detail = await application.inject({
      method: 'GET',
      url: `/api/workflow/jobs/${jobId}`,
      headers: browserHeaders,
    });
    expect(detail.statusCode).toBe(200);
    const previewUrl = detail.json<{ data: { media: { previewUrl: string }[] } }>().data.media[0]
      ?.previewUrl;
    expect(previewUrl).toBe(`/api/workflow/media/${firstBody.data.id}`);
    if (!previewUrl) throw new Error('Expected a tenant media preview URL');
    const preview = await application.inject({
      method: 'GET',
      url: previewUrl,
      headers: browserHeaders,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toContain('image/png');
    expect(preview.headers['cache-control']).toBe('private, max-age=300');
    expect(preview.rawPayload).toEqual(png);

    browserAuthenticate.mockResolvedValueOnce({
      workspaceId: foreignWorkspaceId,
      userId,
      role: 'owner',
    });
    expect(
      (await application.inject({ method: 'GET', url: previewUrl, headers: browserHeaders }))
        .statusCode,
    ).toBe(404);
    browserAuthenticate.mockResolvedValueOnce(null);
    expect((await application.inject({ method: 'GET', url: previewUrl })).statusCode).toBe(401);

    const directory = await mkdtemp(join(tmpdir(), 'publish-relay-media-cli-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'daily-vibe.png');
    await writeFile(path, png);
    const cliUpload = await runCli([
      'media',
      'upload',
      '--file',
      path,
      '--content-type',
      'image/png',
      '--idempotency-key',
      'media-upload-cli-1',
    ]);
    expect(cliUpload.code).toBe(0);
    expect(cliUpload.body).toMatchObject({
      success: true,
      data: { mimeType: 'image/png', byteSize: png.length, state: 'ready' },
    });
  });

  it('rejects unauthenticated, unsupported, empty, and malformed uploads without storage', async () => {
    authenticate.mockResolvedValueOnce(null);
    expect(
      (await application.inject({ method: 'POST', url: '/api/v1/media', headers, payload: png }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await application.inject({
          method: 'POST',
          url: '/api/v1/media',
          headers: { ...headers, 'content-type': 'text/plain' },
          payload: png,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await application.inject({
          method: 'POST',
          url: '/api/v1/media',
          headers,
          payload: Buffer.alloc(0),
        })
      ).statusCode,
    ).toBe(400);
    expect(storedMedia.size).toBe(0);
  });

  it('rejects declared and detected MIME mismatches before reserving mutation state', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
    const response = await application.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { ...headers, 'idempotency-key': 'media-mime-mismatch' },
      payload: jpeg,
    });
    expect(response.statusCode).toBe(400);
    expect(storedMedia.size).toBe(0);
    const rows = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM api_mutation_results WHERE idempotency_key = 'media-mime-mismatch'",
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it('enforces the upload body limit at the HTTP boundary', async () => {
    const oversized = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024 - png.length + 1)]);
    const response = await application.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { ...headers, 'idempotency-key': 'media-oversized' },
      payload: oversized,
    });
    expect(response.statusCode).toBe(413);
    expect(storedMedia.size).toBe(0);
  });

  it('rejects missing content:write capability before storage or idempotency', async () => {
    requireCapability.mockRejectedValueOnce(
      new ApiKeyAuthorizationError('Insufficient capability'),
    );
    const response = await application.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { ...headers, 'idempotency-key': 'media-no-capability' },
      payload: png,
    });
    expect(response.statusCode).toBe(403);
    expect(storedMedia.size).toBe(0);
    const rows = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM api_mutation_results WHERE idempotency_key = 'media-no-capability'",
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it('rate limits before reserving idempotency state', async () => {
    for (let index = 0; index < 10; index += 1) {
      const accepted = await application.inject({
        method: 'POST',
        url: '/api/v1/media',
        headers: { ...headers, 'idempotency-key': `media-rate-${String(index)}` },
        payload: png,
      });
      expect(accepted.statusCode).toBe(201);
    }
    const rejected = await application.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { ...headers, 'idempotency-key': 'media-rate-rejected' },
      payload: png,
    });
    expect(rejected.statusCode).toBe(429);
    const rows = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM api_mutation_results WHERE idempotency_key = 'media-rate-rejected'",
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it('rolls back database and storage ownership when storage fails', async () => {
    mediaPutError = new Error('storage unavailable');
    const response = await application.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { ...headers, 'idempotency-key': 'media-storage-failure' },
      payload: png,
    });
    expect(response.statusCode).toBe(500);
    expect(storedMedia.size).toBe(0);
    const rows = await database.query<{ media: number; mutations: number }>(
      `SELECT
        (SELECT count(*)::int FROM media_objects WHERE workspace_id = '${workspaceId}') AS media,
        (SELECT count(*)::int FROM api_mutation_results WHERE idempotency_key = 'media-storage-failure') AS mutations`,
    );
    expect(rows.rows[0]).toEqual({ media: 0, mutations: 0 });
  });
});

describe('browser workflow PostgreSQL boundary', () => {
  const browserHeaders = {
    cookie: `publish_relay_session=${workspaceId}.browser-token`,
  };

  it('holds an opted-in job until exact workspace operator approval and preserves default-off jobs', async () => {
    const headers = {
      ...browserHeaders,
      cookie: `${browserHeaders.cookie}; publish_relay_csrf=approval-csrf`,
      'x-csrf-token': 'approval-csrf',
    };
    const created = await application.inject({
      method: 'POST',
      url: '/api/workflow/posts',
      headers: { ...headers, 'idempotency-key': 'approval-held-create' },
      payload: { ...requestPayload('Held exact revision'), approvalRequired: true },
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json<{ data: { jobIds: string[] } }>().data.jobIds[0];
    expect(jobId).toBeTruthy();
    const url = `/api/workflow/jobs/${jobId ?? ''}`;
    const detail = await application.inject({ method: 'GET', url, headers: browserHeaders });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      approvalRequired: true,
      approvalStatus: 'awaiting_approval',
      canApprove: true,
    });
    const machineHeaders = {
      authorization: 'Bearer pr_test.secret',
      'x-publish-relay-workspace': workspaceId,
    };
    const machineDetail = await application.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobId ?? ''}`,
      headers: machineHeaders,
    });
    expect(machineDetail.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      approvalRequired: true,
      approvalStatus: 'awaiting_approval',
    });
    const heldList = await application.inject({
      method: 'GET',
      url: '/api/v1/jobs?approvalStatus=awaiting_approval',
      headers: machineHeaders,
    });
    expect(heldList.statusCode).toBe(200);
    expect(
      heldList.json<{ data: { items: { id: string }[] } }>().data.items.map((item) => item.id),
    ).toContain(jobId);
    browserAuthenticate.mockResolvedValueOnce({ workspaceId, userId, role: 'viewer' });
    expect(
      (await application.inject({ method: 'POST', url: `${url}/approve`, headers })).statusCode,
    ).toBe(403);
    const approved = await application.inject({ method: 'POST', url: `${url}/approve`, headers });
    expect(approved.statusCode).toBe(200);
    expect(approved.json<{ data: { approvalStatus: string } }>().data.approvalStatus).toBe(
      'approved',
    );
    const approvedList = await application.inject({
      method: 'GET',
      url: '/api/v1/jobs?approvalStatus=approved',
      headers: machineHeaders,
    });
    expect(approvedList.statusCode).toBe(200);
    expect(
      approvedList.json<{ data: { items: { id: string }[] } }>().data.items.map((item) => item.id),
    ).toContain(jobId);
    expect(
      (await application.inject({ method: 'POST', url: `${url}/approve`, headers })).json(),
    ).toEqual(approved.json());
    const after = await application.inject({ method: 'GET', url, headers: browserHeaders });
    expect(after.json<{ data: { approvalStatus: string } }>().data.approvalStatus).toBe('approved');
    expect(
      (
        await application.inject({
          method: 'POST',
          url: `/api/workflow/jobs/${foreignJobId}/approve`,
          headers,
        })
      ).statusCode,
    ).toBe(404);

    const legacy = await application.inject({
      method: 'POST',
      url: '/api/workflow/posts',
      headers: { ...headers, 'idempotency-key': 'approval-default-create' },
      payload: requestPayload('Legacy default'),
    });
    expect(legacy.statusCode).toBe(201);
    const legacyJobId = legacy.json<{ data: { jobIds: string[] } }>().data.jobIds[0];
    const legacyDetail = await application.inject({
      method: 'GET',
      url: `/api/workflow/jobs/${legacyJobId ?? ''}`,
      headers: browserHeaders,
    });
    expect(legacyDetail.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      approvalRequired: false,
      approvalStatus: 'not_required',
    });
    const toggle = (id: string, required: boolean, key: string) =>
      application.inject({
        method: 'PATCH',
        url: `/api/workflow/jobs/${id}/approval-requirement`,
        headers: { ...headers, 'idempotency-key': key },
        payload: { approvalRequired: required },
      });
    const held = await toggle(legacyJobId ?? '', true, 'approval-toggle-on');
    expect(held.statusCode).toBe(200);
    const successorId = held.json<{ data: { jobId: string } }>().data.jobId;
    expect(successorId).not.toBe(legacyJobId);
    expect((await toggle(legacyJobId ?? '', true, 'approval-toggle-on')).json()).toEqual(
      held.json(),
    );
    expect(
      (
        await application.inject({
          method: 'POST',
          url: `/api/workflow/jobs/${legacyJobId ?? ''}/approve`,
          headers,
        })
      ).statusCode,
    ).toBe(409);
    const successorDetail = await application.inject({
      method: 'GET',
      url: `/api/workflow/jobs/${successorId}`,
      headers: browserHeaders,
    });
    expect(successorDetail.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      approvalStatus: 'awaiting_approval',
    });
    const released = await toggle(successorId, false, 'approval-toggle-off');
    expect(released.statusCode).toBe(200);
    const releasedId = released.json<{ data: { jobId: string } }>().data.jobId;
    const releasedDetail = await application.inject({
      method: 'GET',
      url: `/api/workflow/jobs/${releasedId}`,
      headers: browserHeaders,
    });
    expect(releasedDetail.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      approvalStatus: 'not_required',
    });
    browserAuthenticate.mockResolvedValueOnce({ workspaceId, userId, role: 'viewer' });
    expect((await toggle(releasedId, true, 'approval-viewer')).statusCode).toBe(403);
    expect((await toggle(foreignJobId, true, 'approval-foreign')).statusCode).toBe(404);
    await database.exec(`UPDATE publication_jobs SET state = 'leased' WHERE id = '${releasedId}'`);
    expect((await toggle(releasedId, true, 'approval-claimed')).statusCode).toBe(409);
  });

  it('admits a paid Fanvue media post only for its ready selected account', async () => {
    const mediaId = '00000000-0000-4000-8000-000000000890';
    await database.exec(`
      UPDATE provider_connections SET provider = 'fanvue' WHERE workspace_id = '${workspaceId}';
      UPDATE provider_accounts SET destination_provider = 'fanvue'
        WHERE id = '${providerAccountId}';
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
        VALUES ('${mediaId}', '${workspaceId}', 'clip.jpg', 'clip-hash', 'image/jpeg', 10, 'ready');
    `);
    const headers = {
      ...browserHeaders,
      cookie: `${browserHeaders.cookie}; publish_relay_csrf=fanvue-csrf`,
      'x-csrf-token': 'fanvue-csrf',
    };
    const payload = {
      destination: { provider: 'fanvue', providerAccountId },
      content: {
        schemaVersion: 1,
        kind: 'post',
        audience: 'subscribers',
        text: 'Paid clip',
        mediaIds: [mediaId],
        price: 300,
      },
      scheduledAt: '2026-09-02T10:00:00.000Z',
    };
    const send = (key: string, body: Record<string, unknown>) =>
      application.inject({
        method: 'POST',
        url: '/api/workflow/posts',
        headers: { ...headers, 'idempotency-key': key },
        payload: body,
      });
    const created = await send('fanvue-paid-ready', payload);
    expect(created.statusCode).toBe(201);
    const rows = await database.query<{ effective_payload: Record<string, unknown> }>(
      `SELECT effective_payload FROM publication_jobs WHERE workspace_id = '${workspaceId}'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.effective_payload).toMatchObject({
      kind: 'post',
      audience: 'subscribers',
      price: 300,
      mediaIds: [mediaId],
    });
    const foreign = await send('fanvue-foreign-account', {
      ...payload,
      destination: { provider: 'fanvue', providerAccountId: foreignProviderAccountId },
    });
    expect(foreign.statusCode).toBe(400);
    await database.exec(`UPDATE media_objects SET state = 'temporary' WHERE id = '${mediaId}'`);
    const notReady = await send('fanvue-media-not-ready', payload);
    expect(notReady.statusCode).toBe(400);
    expect(
      (
        await database.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM publication_jobs WHERE workspace_id = '${workspaceId}'`,
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it('rejects a disconnected Meta destination while its sibling remains schedulable', async () => {
    const facebookId = '00000000-0000-4000-8000-000000000890';
    const imageId = '00000000-0000-4000-8000-000000000891';
    await database.exec(`
      UPDATE provider_connections SET provider = 'meta' WHERE workspace_id = '${workspaceId}';
      UPDATE provider_accounts SET destination_provider = 'instagram'
        WHERE id = '${providerAccountId}';
      INSERT INTO provider_accounts
        (id, workspace_id, connection_id, provider_account_id, remote_account_id, display_name, destination_provider)
        VALUES ('${facebookId}', '${workspaceId}', '00000000-0000-4000-8000-000000000806',
          'page-one', 'page-one', 'Page One', 'facebook_page');
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
        VALUES ('${imageId}', '${workspaceId}', 'meta.jpg', 'meta-image', 'image/jpeg', 10, 'ready');
    `);
    const db = drizzle(database) as unknown as NodePgDatabase;
    await expect(
      disconnectProviderAccount(db, {
        workspaceId,
        userId,
        accountId: providerAccountId,
        requestId: 'meta-disconnect-one',
      }),
    ).resolves.toBe('disconnected');
    const headers = {
      ...browserHeaders,
      cookie: `${browserHeaders.cookie}; publish_relay_csrf=meta-disconnect-csrf`,
      'x-csrf-token': 'meta-disconnect-csrf',
    };
    const create = (
      key: string,
      accountId: string,
      content: Record<string, unknown>,
      mediaIds: string[],
    ) =>
      application.inject({
        method: 'POST',
        url: '/api/workflow/posts',
        headers: { ...headers, 'idempotency-key': key },
        payload: {
          content,
          mediaIds,
          providerAccountIds: [accountId],
          scheduledAt: '2026-09-02T10:00:00.000Z',
        },
      });
    const rejected = await create(
      'meta-disconnected-destination',
      providerAccountId,
      { kind: 'single_image', text: 'Disconnected' },
      [imageId],
    );
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({
      error: 'One or more provider accounts are disconnected',
    });
    const sibling = await create(
      'meta-connected-sibling',
      facebookId,
      { kind: 'link', text: 'Connected', linkUrl: 'https://example.com/post' },
      [],
    );
    expect(sibling.statusCode).toBe(201);
    await database.exec(`UPDATE provider_connections SET status = 'disconnected'
      WHERE workspace_id = '${workspaceId}' AND provider = 'meta'`);
    const connectionRejected = await create(
      'meta-disconnected-connection',
      facebookId,
      { kind: 'link', text: 'Blocked', linkUrl: 'https://example.com/post' },
      [],
    );
    expect(connectionRejected.statusCode).toBe(400);
    expect(connectionRejected.json()).toMatchObject({
      error: 'One or more provider accounts are disconnected',
    });
    const counts = await database.query<{ posts: number; jobs: number; mutations: number }>(`
      SELECT (SELECT count(*)::int FROM posts WHERE workspace_id = '${workspaceId}') AS posts,
        (SELECT count(*)::int FROM publication_jobs WHERE workspace_id = '${workspaceId}') AS jobs,
        (SELECT count(*)::int FROM browser_mutation_results WHERE idempotency_key
          IN ('meta-disconnected-destination', 'meta-disconnected-connection')) AS mutations`);
    expect(counts.rows[0]).toEqual({ posts: 1, jobs: 1, mutations: 0 });
  });

  it('persists independent Meta jobs and rejects unavailable, incompatible, or foreign targets', async () => {
    const facebookId = '00000000-0000-4000-8000-000000000890';
    const imageId = '00000000-0000-4000-8000-000000000891';
    await database.exec(`
      UPDATE provider_connections SET provider = 'meta' WHERE workspace_id = '${workspaceId}';
      UPDATE provider_accounts SET destination_provider = 'instagram'
        WHERE id = '${providerAccountId}';
      INSERT INTO provider_accounts
        (id, workspace_id, connection_id, provider_account_id, remote_account_id, display_name, destination_provider)
        VALUES ('${facebookId}', '${workspaceId}', '00000000-0000-4000-8000-000000000806',
          'page-one', 'page-one', 'Page One', 'facebook_page');
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
        VALUES ('${imageId}', '${workspaceId}', 'meta.jpg', 'meta-image', 'image/jpeg', 10, 'ready');
    `);
    const headers = {
      ...browserHeaders,
      cookie: `${browserHeaders.cookie}; publish_relay_csrf=meta-csrf`,
      'x-csrf-token': 'meta-csrf',
    };
    const payload = {
      content: { kind: 'single_image', text: 'Shared caption' },
      mediaIds: [imageId],
      providerAccountIds: [providerAccountId, facebookId],
      scheduledAt: '2026-09-02T10:00:00.000Z',
    };
    const create = (key: string, body: typeof payload) =>
      application.inject({
        method: 'POST',
        url: '/api/workflow/posts',
        headers: { ...headers, 'idempotency-key': key },
        payload: body,
      });
    const created = await create('meta-two-targets', payload);
    expect(created.statusCode).toBe(201);
    const jobs = await database.query<{
      provider_account_id: string;
      effective_payload: Record<string, unknown>;
    }>(`SELECT provider_account_id, effective_payload FROM publication_jobs
      WHERE workspace_id = '${workspaceId}' ORDER BY provider_account_id`);
    expect(jobs.rows).toHaveLength(2);
    expect(
      jobs.rows.find((job) => job.provider_account_id === providerAccountId)?.effective_payload,
    ).toMatchObject({
      destinationProvider: 'instagram',
      caption: 'Shared caption',
      mediaIds: [imageId],
    });
    expect(
      jobs.rows.find((job) => job.provider_account_id === facebookId)?.effective_payload,
    ).toMatchObject({
      destinationProvider: 'facebook_page',
      message: 'Shared caption',
      mediaIds: [imageId],
    });
    expect(jobs.rows[0]?.effective_payload).not.toEqual(jobs.rows[1]?.effective_payload);

    for (const availability of ['reauth_required', 'permission_lost', 'remote_missing']) {
      await database.exec(
        `UPDATE provider_accounts SET availability = '${availability}' WHERE id = '${facebookId}'`,
      );
      const response = await create(`meta-${availability}`, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: `Destination is unavailable: ${availability}`,
      });
    }
    await database.exec(
      `UPDATE provider_accounts SET availability = 'active' WHERE id = '${facebookId}'`,
    );
    expect(
      (
        await create('meta-no-carousel-intersection', {
          ...payload,
          content: { kind: 'carousel', text: 'Unsupported together' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await create('meta-foreign-target', {
          ...payload,
          providerAccountIds: [providerAccountId, foreignProviderAccountId],
        })
      ).statusCode,
    ).toBe(400);
    const unchanged = await database.query<{
      provider_account_id: string;
      effective_payload: Record<string, unknown>;
    }>(`SELECT provider_account_id, effective_payload FROM publication_jobs
      WHERE workspace_id = '${workspaceId}' ORDER BY provider_account_id`);
    expect(unchanged.rows).toEqual(jobs.rows);
  });

  it('persists authenticated media and replays the exact uncertain post intent once', async () => {
    const headers = {
      ...browserHeaders,
      cookie: `${browserHeaders.cookie}; publish_relay_csrf=browser-csrf`,
      'x-csrf-token': 'browser-csrf',
    };
    const bytesA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const bytesB = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]);
    const upload = (bytes: Buffer, key: string) =>
      application.inject({
        method: 'POST',
        url: '/api/workflow/media',
        headers: {
          ...headers,
          'content-type': 'image/png',
          'x-file-name': 'image.png',
          'idempotency-key': key,
        },
        payload: bytes,
      });
    const firstMedia = await upload(bytesA, 'uncertain-media-a');
    const secondMedia = await upload(bytesB, 'uncertain-media-b');
    expect(firstMedia.statusCode).toBe(201);
    expect(secondMedia.statusCode).toBe(201);
    const idA = firstMedia.json<{ data: { id: string } }>().data.id;
    const idB = secondMedia.json<{ data: { id: string } }>().data.id;
    expect(idA).not.toBe(idB);
    const payload = { ...requestPayload('Image A'), mediaIds: [idA] };
    const request = {
      method: 'POST' as const,
      url: '/api/workflow/posts',
      headers: { ...headers, 'idempotency-key': 'uncertain-post-a' },
      payload,
    };
    const created = await application.inject(request);
    const replayed = await application.inject(request);
    expect(created.statusCode).toBe(201);
    expect(replayed.statusCode).toBe(201);
    expect(replayed.headers['idempotency-replayed']).toBe('true');
    expect(replayed.json()).toEqual(created.json());
    const changedUnderOldKey = await application.inject({
      ...request,
      payload: { ...payload, content: { type: 'text', text: 'Image B' }, mediaIds: [idB] },
    });
    expect(changedUnderOldKey.statusCode).toBe(409);
    const persisted = await database.query<{ media_id: string; text: string }>(`
      SELECT rm.media_id, pr.content->>'text' AS text
      FROM revision_media rm JOIN post_revisions pr ON pr.id = rm.revision_id
      WHERE rm.workspace_id = '${workspaceId}'
    `);
    expect(persisted.rows).toEqual([{ media_id: idA, text: 'Image A' }]);
    const counts = await database.query<{ posts: number; mutations: number }>(`
      SELECT (SELECT count(*)::int FROM posts WHERE workspace_id = '${workspaceId}') AS posts,
        (SELECT count(*)::int FROM browser_mutation_results WHERE workspace_id = '${workspaceId}' AND operation = 'create-post') AS mutations
    `);
    expect(counts.rows[0]).toEqual({ posts: 1, mutations: 1 });
  });

  it('creates once for a browser principal and rejects changed idempotent replays', async () => {
    const request = {
      method: 'POST' as const,
      url: '/api/workflow/posts',
      headers: {
        ...browserHeaders,
        cookie: `${browserHeaders.cookie}; publish_relay_csrf=browser-csrf`,
        'x-csrf-token': 'browser-csrf',
        'idempotency-key': 'browser-create-1',
      },
      payload: requestPayload('Browser post'),
    };
    const created = await application.inject(request);
    const replayed = await application.inject(request);
    expect(created.statusCode).toBe(201);
    expect(replayed.statusCode).toBe(201);
    expect(replayed.headers['idempotency-replayed']).toBe('true');
    expect(replayed.json()).toEqual(created.json());

    const conflict = await application.inject({
      ...request,
      payload: requestPayload('Changed browser post'),
    });
    expect(conflict.statusCode).toBe(409);
    const counts = await database.query<{ posts: number; mutations: number }>(
      `SELECT
        (SELECT count(*)::int FROM posts WHERE workspace_id = '${workspaceId}') AS posts,
        (SELECT count(*)::int FROM browser_mutation_results WHERE workspace_id = '${workspaceId}') AS mutations`,
    );
    expect(counts.rows[0]).toEqual({ posts: 1, mutations: 1 });
  });

  it('hydrates and transitions an imported draft exactly once', async () => {
    const draftId = '00000000-0000-4000-8000-000000000850';
    const mediaId = '00000000-0000-4000-8000-000000000807';
    await database.exec(`
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state)
      VALUES ('${mediaId}', '${workspaceId}', 'draft.jpg', 'draft-hash', 'image/jpeg', 10, 'ready');
      INSERT INTO external_drafts
        (id, workspace_id, source_actor_type, source_actor_id, external_id, label, request_fingerprint)
      VALUES ('${draftId}', '${workspaceId}', 'api_key', '${apiKeyId}', 'clip-850', 'Approved clip', 'fingerprint');
      INSERT INTO external_draft_media (workspace_id, draft_id, media_id, position)
      VALUES ('${workspaceId}', '${draftId}', '${mediaId}', 0);
    `);
    const hydrated = await application.inject({
      method: 'GET',
      url: `/api/workflow/drafts/${draftId}`,
      headers: browserHeaders,
    });
    expect(hydrated.statusCode).toBe(200);
    expect(hydrated.json()).toEqual({
      data: {
        id: draftId,
        label: 'Approved clip',
        mediaIds: [mediaId],
        media: [
          {
            id: mediaId,
            mimeType: 'image/jpeg',
            byteSize: 10,
            durationMs: null,
            ready: true,
            previewUrl: `/api/workflow/media/${mediaId}`,
          },
        ],
        postId: null,
      },
      error: null,
    });

    const created = await application.inject({
      method: 'POST',
      url: '/api/workflow/posts',
      headers: {
        ...browserHeaders,
        cookie: `${browserHeaders.cookie}; publish_relay_csrf=browser-csrf`,
        'x-csrf-token': 'browser-csrf',
        'idempotency-key': 'browser-draft-transition',
      },
      payload: {
        ...requestPayload('Imported draft post'),
        mediaIds: [mediaId],
        externalDraftId: draftId,
      },
    });
    expect(created.statusCode).toBe(201);
    const postId = created.json<{ data: { id: string } }>().data.id;
    const transitioned = await database.query<{ post_id: string; action: string }>(
      `SELECT d.post_id, a.action FROM external_drafts d
       JOIN audit_events a ON a.target_id = d.id AND a.action = 'external_draft.transitioned'
       WHERE d.id = '${draftId}'`,
    );
    expect(transitioned.rows).toEqual([{ post_id: postId, action: 'external_draft.transitioned' }]);

    const repeated = await application.inject({
      method: 'POST',
      url: '/api/workflow/posts',
      headers: {
        ...browserHeaders,
        cookie: `${browserHeaders.cookie}; publish_relay_csrf=browser-csrf`,
        'x-csrf-token': 'browser-csrf',
        'idempotency-key': 'browser-draft-transition-again',
      },
      payload: { ...requestPayload('Second post'), mediaIds: [mediaId], externalDraftId: draftId },
    });
    expect(repeated.statusCode).toBe(400);
  });

  it('revises a browser post once and supersedes its previous job', async () => {
    const headers = {
      ...browserHeaders,
      cookie: `${browserHeaders.cookie}; publish_relay_csrf=browser-csrf`,
      'x-csrf-token': 'browser-csrf',
      'idempotency-key': 'browser-create-edit',
    };
    const created = await application.inject({
      method: 'POST',
      url: '/api/workflow/posts',
      headers,
      payload: requestPayload('Original browser post'),
    });
    const postId = created.json<{ data: { id: string } }>().data.id;
    const request = {
      method: 'PATCH' as const,
      url: `/api/workflow/posts/${postId}`,
      headers: { ...headers, 'idempotency-key': 'browser-edit-1' },
      payload: {
        ...requestPayload('Edited browser post'),
        scheduledAt: '2026-09-03T11:00:00.000Z',
      },
    };
    const edited = await application.inject(request);
    const replayed = await application.inject(request);
    expect(edited.statusCode).toBe(200);
    expect(replayed.headers['idempotency-replayed']).toBe('true');
    expect(replayed.json()).toEqual(edited.json());
    expect(edited.json()).toMatchObject({
      data: { postId, supersededJobIds: [expect.any(String)], jobIds: [expect.any(String)] },
    });
    const provenance = await database.query<{
      created_actor_type: string;
      created_actor_id: string;
      last_mutator_type: string;
      last_mutator_id: string;
    }>(
      `SELECT r.created_actor_type, r.created_actor_id, p.last_mutator_type, p.last_mutator_id
       FROM posts p JOIN post_revisions r ON r.post_id = p.id
       WHERE p.id = '${postId}' ORDER BY r.revision_number DESC LIMIT 1`,
    );
    expect(provenance.rows[0]).toEqual({
      created_actor_type: 'user',
      created_actor_id: userId,
      last_mutator_type: 'user',
      last_mutator_id: userId,
    });
  });

  it('hides missing and foreign posts from browser revision mutations', async () => {
    const headers = {
      ...browserHeaders,
      cookie: `${browserHeaders.cookie}; publish_relay_csrf=browser-csrf`,
      'x-csrf-token': 'browser-csrf',
      'idempotency-key': 'browser-edit-missing',
    };
    for (const postId of [missingResourceId, foreignPostId]) {
      const response = await application.inject({
        method: 'PATCH',
        url: `/api/workflow/posts/${postId}`,
        headers: { ...headers, 'idempotency-key': `edit-${postId}` },
        payload: requestPayload('Hidden post edit'),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ data: null, error: 'Post was not found' });
    }
  });

  it('rejects a past browser schedule before reserving idempotency state', async () => {
    const response = await application.inject({
      method: 'POST',
      url: '/api/workflow/posts',
      headers: {
        ...browserHeaders,
        cookie: `${browserHeaders.cookie}; publish_relay_csrf=browser-csrf`,
        'x-csrf-token': 'browser-csrf',
        'idempotency-key': 'browser-past-1',
      },
      payload: { ...requestPayload('Past post'), scheduledAt: '2020-01-01T00:00:00.000Z' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      data: null,
      error: 'Scheduled time must not be in the past',
    });
    const rows = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM browser_mutation_results WHERE idempotency_key = 'browser-past-1'`,
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it('rejects a past browser revision without creating a new revision or job', async () => {
    const headers = {
      ...browserHeaders,
      cookie: `${browserHeaders.cookie}; publish_relay_csrf=browser-csrf`,
      'x-csrf-token': 'browser-csrf',
      'idempotency-key': 'create-before-past-edit',
    };
    const created = await application.inject({
      method: 'POST',
      url: '/api/workflow/posts',
      headers,
      payload: requestPayload('Original'),
    });
    const postId = created.json<{ data: { id: string } }>().data.id;
    const rejected = await application.inject({
      method: 'PATCH',
      url: `/api/workflow/posts/${postId}`,
      headers: { ...headers, 'idempotency-key': 'past-edit-1' },
      payload: { ...requestPayload('Past edit'), scheduledAt: '2020-01-01T00:00:00.000Z' },
    });
    expect(rejected.statusCode).toBe(400);
    const counts = await database.query<{ revisions: number; jobs: number; mutations: number }>(
      `SELECT
        (SELECT count(*)::int FROM post_revisions WHERE post_id = '${postId}') AS revisions,
        (SELECT count(*)::int FROM publication_jobs WHERE post_id = '${postId}') AS jobs,
        (SELECT count(*)::int FROM browser_mutation_results WHERE idempotency_key = 'past-edit-1') AS mutations`,
    );
    expect(counts.rows[0]).toEqual({ revisions: 1, jobs: 1, mutations: 0 });
  });

  it.each([
    { operation: 'create', scheduledAt: '2026-09-02T10:00:00.001Z', expected: 201 },
    { operation: 'create', scheduledAt: '2026-09-02T09:59:59.999Z', expected: 400 },
    { operation: 'edit', scheduledAt: '2026-09-02T10:00:00.001Z', expected: 200 },
    { operation: 'edit', scheduledAt: '2026-09-02T09:59:59.999Z', expected: 400 },
  ] as const)(
    '$operation schedule at $scheduledAt returns $expected around the grace boundary',
    async ({ operation, scheduledAt, expected }) => {
      browserNow = new Date('2026-09-02T10:01:00.000Z');
      const headers = {
        ...browserHeaders,
        cookie: `${browserHeaders.cookie}; publish_relay_csrf=browser-csrf`,
        'x-csrf-token': 'browser-csrf',
        'idempotency-key': `boundary-${operation}-${String(expected)}`,
      };
      let postId: string | undefined;
      if (operation === 'edit') {
        browserNow = new Date('2026-09-01T10:01:00.000Z');
        const created = await application.inject({
          method: 'POST',
          url: '/api/workflow/posts',
          headers: { ...headers, 'idempotency-key': `boundary-edit-base-${String(expected)}` },
          payload: requestPayload('Boundary edit base'),
        });
        postId = created.json<{ data: { id: string } }>().data.id;
        browserNow = new Date('2026-09-02T10:01:00.000Z');
      }
      if (operation === 'edit' && !postId) throw new Error('Missing boundary edit post');
      const response = await application.inject({
        method: operation === 'create' ? 'POST' : 'PATCH',
        url:
          operation === 'create' ? '/api/workflow/posts' : `/api/workflow/posts/${String(postId)}`,
        headers,
        payload: { ...requestPayload('Boundary schedule'), scheduledAt },
      });
      expect(response.statusCode).toBe(expected);
      const mutations = await database.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM browser_mutation_results WHERE idempotency_key = 'boundary-${operation}-${String(expected)}'`,
      );
      expect(mutations.rows[0]?.count).toBe(expected === 400 ? 0 : 1);
    },
  );

  it.each([
    {
      name: 'duplicate account targets',
      key: 'edit-duplicate-accounts',
      payload: { providerAccountIds: [providerAccountId, providerAccountId] },
    },
    {
      name: 'a foreign account target',
      key: 'edit-foreign-account',
      payload: { providerAccountIds: [foreignProviderAccountId] },
    },
    {
      name: 'a foreign media target',
      key: 'edit-foreign-media',
      payload: { mediaIds: [foreignMediaId] },
    },
  ])('rolls back an existing browser post edit with $name', async ({ key, payload }) => {
    const headers = {
      ...browserHeaders,
      cookie: `${browserHeaders.cookie}; publish_relay_csrf=browser-csrf`,
      'x-csrf-token': 'browser-csrf',
      'idempotency-key': `create-before-${key}`,
    };
    const created = await application.inject({
      method: 'POST',
      url: '/api/workflow/posts',
      headers,
      payload: requestPayload('Original atomic edit'),
    });
    const postId = created.json<{ data: { id: string } }>().data.id;
    const before = await database.query<{ revisions: number; jobs: number; scheduled: number }>(
      `SELECT
        (SELECT count(*)::int FROM post_revisions WHERE post_id = '${postId}') AS revisions,
        (SELECT count(*)::int FROM publication_jobs WHERE post_id = '${postId}') AS jobs,
        (SELECT count(*)::int FROM publication_jobs WHERE post_id = '${postId}' AND state = 'scheduled') AS scheduled`,
    );

    const rejected = await application.inject({
      method: 'PATCH',
      url: `/api/workflow/posts/${postId}`,
      headers: { ...headers, 'idempotency-key': key },
      payload: { ...requestPayload('Rejected atomic edit'), ...payload },
    });
    expect(rejected.statusCode).toBe(400);
    const after = await database.query<{
      revisions: number;
      jobs: number;
      scheduled: number;
      mutations: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM post_revisions WHERE post_id = '${postId}') AS revisions,
        (SELECT count(*)::int FROM publication_jobs WHERE post_id = '${postId}') AS jobs,
        (SELECT count(*)::int FROM publication_jobs WHERE post_id = '${postId}' AND state = 'scheduled') AS scheduled,
        (SELECT count(*)::int FROM browser_mutation_results WHERE idempotency_key = '${key}') AS mutations`,
    );
    expect(after.rows[0]).toEqual({ ...before.rows[0], mutations: 0 });
  });

  it('rejects a foreign browser target without post, job, or idempotency residue', async () => {
    const response = await application.inject({
      method: 'POST',
      url: '/api/workflow/posts',
      headers: {
        ...browserHeaders,
        cookie: `${browserHeaders.cookie}; publish_relay_csrf=browser-csrf`,
        'x-csrf-token': 'browser-csrf',
        'idempotency-key': 'browser-foreign-1',
      },
      payload: {
        ...requestPayload('Foreign target'),
        providerAccountIds: [foreignProviderAccountId],
      },
    });
    expect(response.statusCode).toBe(400);
    const rows = await database.query<{ posts: number; jobs: number; mutations: number }>(
      `SELECT
        (SELECT count(*)::int FROM posts WHERE workspace_id = '${workspaceId}') AS posts,
        (SELECT count(*)::int FROM publication_jobs WHERE workspace_id = '${workspaceId}') AS jobs,
        (SELECT count(*)::int FROM browser_mutation_results WHERE idempotency_key = 'browser-foreign-1') AS mutations`,
    );
    expect(rows.rows[0]).toEqual({ posts: 0, jobs: 0, mutations: 0 });
  });

  it('paginates and filters real tenant rows without exposing foreign or private fields', async () => {
    for (const [key, text] of [
      ['browser-one', 'First browser post'],
      ['browser-two', 'Second browser post'],
    ] as const) {
      const created = await application.inject({
        method: 'POST',
        url: '/api/v1/posts',
        headers: {
          authorization: 'Bearer pr_test.secret',
          'x-publish-relay-workspace': workspaceId,
          'idempotency-key': key,
        },
        payload: requestPayload(text),
      });
      expect(created.statusCode).toBe(201);
    }

    const first = await application.inject({
      method: 'GET',
      url: `/api/workflow/jobs?limit=1&states=scheduled&providerAccountId=${providerAccountId}`,
      headers: browserHeaders,
    });
    expect(first.statusCode).toBe(200);
    expect(first.body).not.toContain('Foreign tenant secret');
    expect(first.body).not.toContain('workspaceId');
    expect(first.body).not.toContain('credentialId');
    const firstBody = first.json<{
      data: {
        items: { id: string; contentPreview: string }[];
        next: { beforeScheduledAt: string; beforeId: string };
      };
    }>();
    expect(firstBody.data.items).toHaveLength(1);
    expect(firstBody.data.next).toBeTruthy();

    const second = await application.inject({
      method: 'GET',
      url: `/api/workflow/jobs?limit=1&states=scheduled&providerAccountId=${providerAccountId}&beforeScheduledAt=${encodeURIComponent(firstBody.data.next.beforeScheduledAt)}&beforeId=${firstBody.data.next.beforeId}`,
      headers: browserHeaders,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<{ data: { items: { id: string }[] } }>();
    expect(secondBody.data.items).toHaveLength(1);
    expect(secondBody.data.items[0]?.id).not.toBe(firstBody.data.items[0]?.id);

    const windowed = await application.inject({
      method: 'GET',
      url: `/api/workflow/jobs?limit=100&states=scheduled&providerAccountId=${providerAccountId}&scheduledAfter=2026-09-02T09%3A00%3A00.000Z&scheduledBefore=2026-09-02T11%3A00%3A00.000Z`,
      headers: browserHeaders,
    });
    expect(windowed.statusCode).toBe(200);
    expect(windowed.json<{ data: { items: unknown[] } }>().data.items).toHaveLength(2);

    const outOfWindow = await application.inject({
      method: 'GET',
      url: `/api/workflow/jobs?limit=100&states=scheduled&providerAccountId=${providerAccountId}&scheduledAfter=2026-09-03T09%3A00%3A00.000Z&scheduledBefore=2026-09-03T11%3A00%3A00.000Z`,
      headers: browserHeaders,
    });
    expect(outOfWindow.statusCode).toBe(200);
    expect(outOfWindow.json<{ data: { items: unknown[] } }>().data.items).toHaveLength(0);

    const oversizedWindow = await application.inject({
      method: 'GET',
      url: `/api/workflow/jobs?scheduledAfter=2026-09-01T00%3A00%3A00.000Z&scheduledBefore=2026-09-09T00%3A00%3A00.000Z`,
      headers: browserHeaders,
    });
    expect(oversizedWindow.statusCode).toBe(400);

    const detail = await application.inject({
      method: 'GET',
      url: `/api/workflow/jobs/${firstBody.data.items[0]?.id ?? ''}`,
      headers: browserHeaders,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain('Foreign tenant secret');
    expect(detail.body).not.toContain('workspaceId');
    expect(detail.body).not.toContain('credentialId');

    const foreign = await application.inject({
      method: 'GET',
      url: `/api/workflow/jobs/${foreignJobId}`,
      headers: browserHeaders,
    });
    expect(foreign.statusCode).toBe(404);
  });
});

afterEach(async () => {
  await application.close();
  await database.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('POST /api/v1/posts', () => {
  it('previews media-bearing X thread parts before upload without accepting other shapes or writes', async () => {
    const headers = {
      authorization: 'Bearer pr_test.secret',
      'x-publish-relay-workspace': workspaceId,
    };
    await database.exec(
      `UPDATE provider_accounts SET destination_provider = 'x' WHERE id = '${providerAccountId}'`,
    );
    const content = {
      kind: 'thread',
      posts: [
        { text: 'a'.repeat(200), mediaIds: [] },
        { text: 'b'.repeat(200), mediaIds: [] },
      ],
    };
    const payload = { ...requestPayload(), content, validationPreview: { xMediaPresent: true } };
    const validate = (candidate: Record<string, unknown>) =>
      application.inject({
        method: 'POST',
        url: '/api/v1/posts/validate',
        headers,
        payload: candidate,
      });
    const ordinary = await validate({ ...payload, validationPreview: undefined });
    expect(ordinary.json<{ data: { valid: boolean } }>().data.valid).toBe(false);
    const preview = await validate(payload);
    expect(preview.statusCode).toBe(200);
    expect(
      preview.json<{
        data: { valid: boolean; mediaNotValidated: boolean; destinations: unknown };
      }>().data,
    ).toEqual({
      valid: true,
      mediaNotValidated: true,
      destinations: [{ providerAccountId, valid: true, weightedLength: 200, limit: 280 }],
    });
    const directory = await mkdtemp(join(tmpdir(), 'publish-relay-x-preview-'));
    temporaryDirectories.push(directory);
    const bodyFile = join(directory, 'candidate.json');
    await writeFile(bodyFile, JSON.stringify(payload));
    const cli = await runCli([
      'posts',
      'validate',
      '--require-workspace',
      workspaceId,
      '--body-file',
      bodyFile,
    ]);
    expect(cli.code).toBe(0);
    expect(cli.body.data).toMatchObject({ valid: true, mediaNotValidated: true });
    const overLimit = await validate({
      ...payload,
      content: { ...content, posts: [content.posts[0], { text: 'b'.repeat(281), mediaIds: [] }] },
    });
    expect(overLimit.json<{ data: { valid: boolean } }>().data.valid).toBe(false);
    await database.exec(
      `UPDATE provider_accounts SET x_long_posts_allowed = true WHERE id = '${providerAccountId}'`,
    );
    const declaredLong = await validate({
      ...payload,
      content: { ...content, posts: [content.posts[0], { text: 'b'.repeat(281), mediaIds: [] }] },
    });
    expect(
      declaredLong.json<{ data: { valid: boolean; destinations: { limit: number }[] } }>().data,
    ).toMatchObject({ valid: true, destinations: [{ limit: 25000 }] });
    const foreign = await validate({ ...payload, providerAccountIds: [foreignProviderAccountId] });
    expect(foreign.json<{ data: { valid: boolean } }>().data.valid).toBe(false);
    await database.exec(
      `UPDATE provider_accounts SET destination_provider = 'linkedin' WHERE id = '${providerAccountId}'`,
    );
    const unsupported = await validate(payload);
    expect(unsupported.statusCode).toBe(200);
    expect(unsupported.json<{ data: { valid: boolean } }>().data.valid).toBe(false);
    await database.exec(
      `UPDATE provider_accounts SET destination_provider = 'x' WHERE id = '${providerAccountId}'`,
    );
    for (const candidate of [
      { ...payload, mediaIds: ['00000000-0000-4000-8000-000000000821'] },
      { ...payload, content: { kind: 'thread', posts: ['first', 'second'] } },
    ]) {
      expect((await validate(candidate)).statusCode).toBe(400);
    }
    const rows = await database.query<{
      posts: number;
      revisions: number;
      jobs: number;
      media: number;
      audit: number;
    }>(
      'SELECT (SELECT count(*) FROM posts)::int AS posts, (SELECT count(*) FROM post_revisions)::int AS revisions, (SELECT count(*) FROM publication_jobs)::int AS jobs, (SELECT count(*) FROM media_objects)::int AS media, (SELECT count(*) FROM audit_events)::int AS audit',
    );
    expect(rows.rows[0]).toEqual({ posts: 1, revisions: 1, jobs: 1, media: 1, audit: 0 });
  });

  it('previews X admission per account without writing and exposes the same CLI result', async () => {
    const headers = {
      authorization: 'Bearer pr_test.secret',
      'x-publish-relay-workspace': workspaceId,
    };
    const longAccountId = '00000000-0000-4000-8000-000000000819';
    await database.exec(`
      UPDATE provider_accounts SET destination_provider = 'x' WHERE id = '${providerAccountId}';
      INSERT INTO provider_accounts
        (id, workspace_id, connection_id, provider_account_id, remote_account_id, destination_provider, display_name, x_long_posts_allowed)
      VALUES ('${longAccountId}', '${workspaceId}', '00000000-0000-4000-8000-000000000806', 'long', 'long', 'x', 'Long', true);
    `);
    const payload = {
      ...requestPayload('x'.repeat(845)),
      providerAccountIds: [providerAccountId, longAccountId],
    };
    const preview = await application.inject({
      method: 'POST',
      url: '/api/v1/posts/validate',
      headers,
      payload,
    });
    expect(preview.statusCode).toBe(200);
    const data = preview.json<{ data: { valid: boolean; destinations: unknown } }>().data;
    expect(data.valid).toBe(false);
    expect(data.destinations).toEqual([
      {
        providerAccountId,
        valid: false,
        error: 'X post text is 845 weighted characters; selected account limit is 280',
        weightedLength: 845,
        limit: 280,
      },
      { providerAccountId: longAccountId, valid: true, weightedLength: 845, limit: 25000 },
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'publish-relay-post-validate-'));
    temporaryDirectories.push(directory);
    const bodyFile = join(directory, 'candidate.json');
    await writeFile(bodyFile, JSON.stringify(payload));
    const cli = await runCli([
      'posts',
      'validate',
      '--require-workspace',
      workspaceId,
      '--body-file',
      bodyFile,
    ]);
    expect(cli.code).toBe(0);
    expect((cli.body.data as { destinations: unknown }).destinations).toEqual(data.destinations);
    const rows = await database.query<{
      posts: number;
      revisions: number;
      jobs: number;
      audit: number;
      replay: number;
    }>(
      'SELECT (SELECT count(*) FROM posts)::int AS posts, (SELECT count(*) FROM post_revisions)::int AS revisions, (SELECT count(*) FROM publication_jobs)::int AS jobs, (SELECT count(*) FROM audit_events)::int AS audit, (SELECT count(*) FROM api_mutation_results)::int AS replay',
    );
    expect(rows.rows[0]).toEqual({ posts: 1, revisions: 1, jobs: 1, audit: 0, replay: 0 });
  });

  it('hides foreign targets and requires read capability', async () => {
    const headers = {
      authorization: 'Bearer pr_test.secret',
      'x-publish-relay-workspace': workspaceId,
    };
    const foreign = await application.inject({
      method: 'POST',
      url: '/api/v1/posts/validate',
      headers,
      payload: { ...requestPayload(), providerAccountIds: [foreignProviderAccountId] },
    });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json<{ data: { destinations: unknown } }>().data.destinations).toEqual([
      {
        providerAccountId: foreignProviderAccountId,
        valid: false,
        error: 'One or more provider accounts do not belong to the workspace',
      },
    ]);
    authenticate.mockResolvedValueOnce(null);
    const unauthenticated = await application.inject({
      method: 'POST',
      url: '/api/v1/posts/validate',
      headers,
      payload: requestPayload(),
    });
    expect(unauthenticated.statusCode).toBe(401);
    requireCapability.mockRejectedValueOnce(new ApiKeyAuthorizationError('Missing capability'));
    const denied = await application.inject({
      method: 'POST',
      url: '/api/v1/posts/validate',
      headers,
      payload: requestPayload(),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('leaves cleanup-eligible media untouched during preview', async () => {
    const mediaId = '00000000-0000-4000-8000-000000000820';
    await database.exec(`
      INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state, cleanup_eligible_at)
      VALUES ('${mediaId}', '${workspaceId}', 'local-test.jpg', 'test-hash', 'image/jpeg', 10, 'cleanup_eligible', now());
    `);
    const response = await application.inject({
      method: 'POST',
      url: '/api/v1/posts/validate',
      headers: { authorization: 'Bearer pr_test.secret', 'x-publish-relay-workspace': workspaceId },
      payload: { ...requestPayload(), mediaIds: [mediaId] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { valid: boolean } }>().data.valid).toBe(true);
    const media = await database.query<{ state: string; cleanup_eligible_at: Date | null }>(
      `SELECT state, cleanup_eligible_at FROM media_objects WHERE id = '${mediaId}'`,
    );
    expect(media.rows[0]?.state).toBe('cleanup_eligible');
    expect(media.rows[0]?.cleanup_eligible_at).not.toBeNull();
  });

  it('admits exposed Pages for active API-key and delegated principals only', async () => {
    await database.exec(`
      UPDATE provider_connections SET provider = 'meta' WHERE workspace_id = '${foreignWorkspaceId}';
      UPDATE provider_accounts SET destination_provider = 'facebook_page'
        WHERE id = '${foreignProviderAccountId}';
      INSERT INTO provider_account_exposures (workspace_id, provider_account_id)
        VALUES ('${workspaceId}', '${foreignProviderAccountId}');
      UPDATE api_keys SET capabilities = ARRAY['schedules:read', 'schedules:write']
        WHERE id = '${apiKeyId}';
      INSERT INTO registered_clients (id, display_name, client_type, redirect_uris, allowed_scopes)
        VALUES ('example-client-local', 'Example', 'public', ARRAY['https://example.test/callback'],
          ARRAY['schedules:read', 'schedules:write']);
      INSERT INTO delegated_grants (id, workspace_id, user_id, client_id, scopes)
        VALUES ('${delegatedGrantId}', '${workspaceId}', '${userId}', 'example-client-local',
          ARRAY['schedules:read', 'schedules:write']);
    `);
    const payload = {
      content: { kind: 'link', text: 'Shared Page', linkUrl: 'https://example.test/post' },
      mediaIds: [],
      providerAccountIds: [foreignProviderAccountId],
      scheduledAt: '2026-09-02T10:00:00.000Z',
    };
    const verify = async (label: string, token: string) => {
      const headers = {
        authorization: `Bearer ${token}`,
        'x-publish-relay-workspace': workspaceId,
        'idempotency-key': `exposed-${label}`,
      };
      const validation = await application.inject({
        method: 'POST',
        url: '/api/v1/posts/validate',
        headers,
        payload,
      });
      expect(validation.statusCode).toBe(200);
      expect(validation.json<{ data: { valid: boolean } }>().data.valid).toBe(true);
      const created = await application.inject({
        method: 'POST',
        url: '/api/v1/posts',
        headers,
        payload,
      });
      expect(created.statusCode).toBe(201);
      const jobPath = created.json<{ data: { links: { jobs: string[] } } }>().data.links.jobs[0];
      if (!jobPath) throw new Error('Create response omitted the shared Page job link');
      const detail = await application.inject({ method: 'GET', url: jobPath, headers });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        data: {
          providerAccount: {
            id: foreignProviderAccountId,
            displayName: 'Foreign',
            provider: 'meta',
            originWorkspaceName: 'Foreign',
            handle: null,
          },
          links: { self: jobPath },
        },
      });
      const serialized = JSON.stringify(detail.json());
      for (const privateValue of ['wrappedKey', 'ciphertext', 'credentialId', 'remoteAccountId']) {
        expect(serialized).not.toContain(privateValue);
      }
      expect(Buffer.byteLength(serialized)).toBeLessThan(4096);
      return { headers, jobPath };
    };
    const { headers: apiHeaders, jobPath: apiJobPath } = await verify('api', 'pr_test.secret');
    authenticate.mockResolvedValue(null);
    authenticateDelegated.mockResolvedValue({
      grantId: delegatedGrantId,
      workspaceId,
      userId,
      clientId: 'example-client-local',
      scopes: ['schedules:read', 'schedules:write'],
    });
    const { headers: delegatedHeaders, jobPath: delegatedJobPath } = await verify(
      'delegated',
      'delegated-token',
    );
    const outsider = await application.inject({
      method: 'GET',
      url: delegatedJobPath,
      headers: { ...delegatedHeaders, 'x-publish-relay-workspace': foreignWorkspaceId },
    });
    expect(outsider.statusCode).toBe(401);
    const foreignJob = await application.inject({
      method: 'GET',
      url: `/api/v1/jobs/${foreignJobId}`,
      headers: delegatedHeaders,
    });
    expect(foreignJob.statusCode).toBe(404);
    expect(JSON.stringify(foreignJob.json())).not.toContain('Foreign tenant secret');
    const foreignApiKeyId = '00000000-0000-4000-8000-000000000819';
    await database.exec(`
      INSERT INTO api_keys
        (id, workspace_id, created_by_user_id, label, prefix, secret_hash, capabilities)
      VALUES ('${foreignApiKeyId}', '${foreignWorkspaceId}', '${userId}', 'Foreign agent',
        'pr_foreign', 'redacted', ARRAY['schedules:read']);
    `);
    authenticate.mockResolvedValue({
      id: foreignApiKeyId,
      workspaceId: foreignWorkspaceId,
      createdByUserId: userId,
      capabilities: ['schedules:read'],
    });
    authenticateDelegated.mockResolvedValue(null);
    const foreignPrincipal = await application.inject({
      method: 'GET',
      url: delegatedJobPath,
      headers: {
        authorization: 'Bearer pr_foreign.secret',
        'x-publish-relay-workspace': foreignWorkspaceId,
      },
    });
    expect(foreignPrincipal.statusCode).toBe(404);
    expect(JSON.stringify(foreignPrincipal.json())).not.toContain('Shared Page');
    expect(apiJobPath).not.toBe(delegatedJobPath);
    const jobs = await database.query<{ workspace_id: string; provider_account_id: string }>(`
      SELECT workspace_id, provider_account_id FROM publication_jobs
      WHERE provider_account_id = '${foreignProviderAccountId}'
        AND workspace_id = '${workspaceId}' ORDER BY id`);
    expect(jobs.rows).toEqual(
      Array.from({ length: 2 }, () => ({
        workspace_id: workspaceId,
        provider_account_id: foreignProviderAccountId,
      })),
    );
    await database.exec(`UPDATE api_keys SET revoked_at = now() WHERE id = '${apiKeyId}';
      UPDATE delegated_grants SET revoked_at = now() WHERE id = '${delegatedGrantId}';`);
    for (const headers of [apiHeaders, delegatedHeaders]) {
      authenticate.mockResolvedValue(
        headers === apiHeaders
          ? {
              id: apiKeyId,
              workspaceId,
              createdByUserId: userId,
              capabilities: ['schedules:read', 'schedules:write'],
            }
          : null,
      );
      authenticateDelegated.mockResolvedValue(
        headers === delegatedHeaders
          ? {
              grantId: delegatedGrantId,
              workspaceId,
              userId,
              clientId: 'example-client-local',
              scopes: ['schedules:read', 'schedules:write'],
            }
          : null,
      );
      const validation = await application.inject({
        method: 'POST',
        url: '/api/v1/posts/validate',
        headers,
        payload,
      });
      expect(validation.json<{ data: { valid: boolean } }>().data.valid).toBe(false);
      const denied = await application.inject({
        method: 'POST',
        url: '/api/v1/posts',
        headers: { ...headers, 'idempotency-key': `${headers['idempotency-key']}-revoked` },
        payload,
      });
      expect(denied.statusCode).toBe(400);
    }
  });

  it('creates and replays with delegated grant attribution while enforcing scope and workspace', async () => {
    authenticate.mockResolvedValue(null);
    authenticateDelegated.mockResolvedValue({
      grantId: delegatedGrantId,
      workspaceId,
      userId,
      clientId: 'example-client-local',
      scopes: ['schedules:write'],
    });
    const request = {
      method: 'POST' as const,
      url: '/api/v1/posts',
      headers: {
        authorization: 'Bearer delegated-token',
        'x-publish-relay-workspace': workspaceId,
        'idempotency-key': 'delegated-create-post',
      },
      payload: requestPayload('Delegated post'),
    };

    const created = await application.inject(request);
    const replayed = await application.inject(request);
    expect(created.statusCode).toBe(201);
    expect(replayed.statusCode).toBe(201);
    expect(replayed.headers['idempotency-replayed']).toBe('true');
    const attribution = await database.query<{
      actor_type: string;
      actor_id: string;
      mutation_actor_type: string;
    }>(`
      SELECT p.created_actor_type AS actor_type, p.created_actor_id AS actor_id,
             m.actor_type AS mutation_actor_type
      FROM posts p
      JOIN api_mutation_results m ON m.workspace_id = p.workspace_id
      WHERE p.workspace_id = '${workspaceId}' AND m.idempotency_key = 'delegated-create-post'
    `);
    expect(attribution.rows).toEqual([
      { actor_type: 'delegated', actor_id: delegatedGrantId, mutation_actor_type: 'delegated' },
    ]);

    authenticateDelegated.mockResolvedValueOnce({
      grantId: delegatedGrantId,
      workspaceId,
      userId,
      clientId: 'example-client-local',
      scopes: ['schedules:read'],
    });
    const missingScope = await application.inject({
      ...request,
      headers: { ...request.headers, 'idempotency-key': 'delegated-missing-scope' },
    });
    expect(missingScope.statusCode).toBe(403);

    authenticateDelegated.mockResolvedValueOnce({
      grantId: delegatedGrantId,
      workspaceId: foreignWorkspaceId,
      userId,
      clientId: 'example-client-local',
      scopes: ['schedules:write'],
    });
    const wrongWorkspace = await application.inject({
      ...request,
      headers: { ...request.headers, 'idempotency-key': 'delegated-wrong-workspace' },
    });
    expect(wrongWorkspace.statusCode).toBe(401);
  });

  it('persists and returns resolved YouTube settings through the job route', async () => {
    await database.exec(`
      UPDATE provider_connections SET provider = 'youtube'
      WHERE id = '00000000-0000-4000-8000-000000000806';
      UPDATE provider_accounts
      SET destination_provider = 'youtube',
          adapter_defaults = '{"madeForKids":false,"privacyStatus":"unlisted","notifySubscribers":true}'::jsonb
      WHERE id = '${providerAccountId}';
    `);
    const created = await application.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: {
        authorization: 'Bearer pr_test.secret',
        'x-publish-relay-workspace': workspaceId,
        'idempotency-key': 'youtube-settings-1',
      },
      payload: {
        content: {
          kind: 'video',
          providerOptions: {
            youtube: { schemaVersion: 1, title: 'Release', privacyStatus: 'public' },
          },
        },
        providerAccountIds: [providerAccountId],
        scheduledAt: '2026-09-02T10:00:00.000Z',
      },
    });
    expect(created.statusCode).toBe(201);
    const jobPath = created.json<{ data: { links: { jobs: string[] } } }>().data.links.jobs[0];
    if (!jobPath) throw new Error('Create response omitted the YouTube job link');
    const detail = await application.inject({
      method: 'GET',
      url: jobPath,
      headers: {
        authorization: 'Bearer pr_test.secret',
        'x-publish-relay-workspace': workspaceId,
      },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      data: {
        effectiveProviderSettings: {
          schemaVersion: 1,
          title: 'Release',
          privacyStatus: 'public',
          madeForKids: false,
          notifySubscribers: true,
        },
      },
    });
  });

  it('creates from an explicit X destination and rejects a mismatched provider', async () => {
    await database.exec(`
      UPDATE provider_connections SET provider = 'x'
      WHERE id = '00000000-0000-4000-8000-000000000806';
      UPDATE provider_accounts SET destination_provider = 'x'
      WHERE id = '${providerAccountId}';
    `);
    const baseRequest = {
      method: 'POST' as const,
      url: '/api/v1/posts',
      headers: {
        authorization: 'Bearer pr_test.secret',
        'x-publish-relay-workspace': workspaceId,
        'idempotency-key': 'destination-first-x-1',
      },
    };
    const created = await application.inject({
      ...baseRequest,
      payload: {
        destination: { provider: 'x', providerAccountId },
        content: { schemaVersion: 1, kind: 'text', text: 'Destination first' },
        scheduledAt: '2026-09-02T10:00:00.000Z',
      },
    });
    expect(created.statusCode).toBe(201);
    const mismatch = await application.inject({
      ...baseRequest,
      headers: { ...baseRequest.headers, 'idempotency-key': 'destination-first-mismatch-1' },
      payload: {
        destination: { provider: 'youtube', providerAccountId },
        content: {
          schemaVersion: 1,
          kind: 'video',
          mediaId: foreignMediaId,
          providerOptions: { youtube: { schemaVersion: 1, title: 'Video' } },
        },
        scheduledAt: '2026-09-02T10:00:00.000Z',
      },
    });
    expect(mismatch.statusCode).toBe(400);
    const malformedMixed = await application.inject({
      ...baseRequest,
      headers: { ...baseRequest.headers, 'idempotency-key': 'destination-first-malformed-1' },
      payload: {
        destination: { providerAccountId },
        providerAccountIds: [providerAccountId],
        content: { kind: 'text', text: 'Must not fall back' },
        scheduledAt: '2026-09-02T10:00:00.000Z',
      },
    });
    expect(malformedMixed.statusCode).toBe(400);
  });

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
      `SELECT
        (SELECT count(*)::int FROM posts WHERE workspace_id = '${workspaceId}') AS posts,
        (SELECT count(*)::int FROM publication_jobs WHERE workspace_id = '${workspaceId}') AS jobs`,
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

  it('redacts unexpected mutation failures behind the stable error envelope', async () => {
    const internalMessage = 'database password appeared in an internal failure';
    vi.spyOn(database, 'transaction').mockRejectedValueOnce(new Error(internalMessage));
    const failed = await application.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: {
        authorization: 'Bearer pr_test.secret',
        'x-publish-relay-workspace': workspaceId,
        'idempotency-key': 'unexpected-failure',
      },
      payload: requestPayload(),
    });

    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain(internalMessage);
    const failureBody = failed.json<{
      success: boolean;
      error: { code: string; message: string; requestId: string };
    }>();
    expect(failureBody).toMatchObject({
      success: false,
      error: {
        code: 'internal_error',
        message: 'Internal server error',
      },
    });
    expect(typeof failureBody.error.requestId).toBe('string');
  });
});

describe('GET /api/v1/posts and jobs', () => {
  it('selects only the bounded machine job summary fields', () => {
    const query = buildMachineJobListQuery(drizzle(database) as unknown as NodePgDatabase, {
      workspaceId,
      limit: 20,
    }).toSQL().sql;
    expect(query).toContain('"publication_jobs"."post_id"');
    expect(query).toContain('browser_account.display_name');
    expect(query).toContain('resolve_browser_job_account');
    expect(query).not.toMatch(
      /effective_payload|effective_provider_settings|revision_media|post_revisions|created_actor|last_mutator|origin_workspace_name/i,
    );
  });

  it('lists past and future jobs with tenant hiding, filters, stable cursors and bounded output', async () => {
    const headers = {
      authorization: 'Bearer pr_test.secret',
      'x-publish-relay-workspace': workspaceId,
    };
    const jobIds: string[] = [];
    for (const [index, text] of ['Past', 'Future'].entries()) {
      const created = await application.inject({
        method: 'POST',
        url: '/api/v1/posts',
        headers: { ...headers, 'idempotency-key': `jobs-list-${String(index)}` },
        payload: requestPayload(text),
      });
      expect(created.statusCode).toBe(201);
      const links = created.json<{ data: { links: { jobs: string[] } } }>().data.links.jobs;
      const id = links[0]?.split('/').at(-1);
      if (!id) throw new Error('Expected created job');
      jobIds.push(id);
    }
    if (!jobIds[0] || !jobIds[1]) throw new Error('Expected past and future jobs');
    await database.exec(`UPDATE publication_jobs SET scheduled_at = '2026-01-01T00:00:00Z' WHERE id = '${jobIds[0]}';
      UPDATE publication_jobs SET scheduled_at = '2027-01-01T00:00:00Z' WHERE id = '${jobIds[1]}';`);
    await database.exec(`CREATE ROLE publish_relay_app NOLOGIN NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO publish_relay_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO publish_relay_app;
      GRANT EXECUTE ON FUNCTION public.resolve_browser_job_account(uuid, uuid) TO publish_relay_app;
      SET ROLE publish_relay_app;`);
    const first = await application.inject({ method: 'GET', url: '/api/v1/jobs?limit=1', headers });
    expect(first.statusCode).toBe(200);
    const page = first.json<{ data: { items: Record<string, unknown>[]; nextCursor: string } }>()
      .data;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: jobIds[1], state: 'scheduled' });
    expect(page.items[0]).not.toHaveProperty('effectivePayload');
    expect(page.items[0]).not.toHaveProperty('secretHash');
    expect(JSON.stringify(first.json())).not.toContain('Foreign tenant secret');
    expect(Buffer.byteLength(first.body)).toBeLessThan(1500);
    const second = await application.inject({
      method: 'GET',
      url: `/api/v1/jobs?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
      headers,
    });
    expect(second.json<{ data: { items: { id: string }[] } }>().data.items[0]?.id).toBe(jobIds[0]);
    expect(
      (
        await application.inject({
          method: 'GET',
          url: `/api/v1/jobs?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await application.inject({ method: 'GET', url: '/api/v1/jobs?limit=101', headers }))
        .statusCode,
    ).toBe(400);
    const future = await application.inject({
      method: 'GET',
      url: '/api/v1/jobs?scheduledAfter=2026-12-01T00%3A00%3A00.000Z',
      headers,
    });
    expect(
      future.json<{ data: { items: { id: string }[] } }>().data.items.map((item) => item.id),
    ).toEqual([jobIds[1]]);
    const narrowWindow = await application.inject({
      method: 'GET',
      url: '/api/v1/jobs?scheduledAfter=2027-01-01T00%3A00%3A00Z&scheduledBefore=2027-01-01T00%3A00%3A00.100Z',
      headers,
    });
    expect(narrowWindow.statusCode).toBe(200);
    expect(
      narrowWindow.json<{ data: { items: { id: string }[] } }>().data.items.map((item) => item.id),
    ).toEqual([jobIds[1]]);
    expect(
      (
        await application.inject({
          method: 'GET',
          url: '/api/v1/jobs?scheduledAfter=2027-01-01T00%3A00%3A00.100Z&scheduledBefore=2027-01-01T00%3A00%3A00Z',
          headers,
        })
      ).statusCode,
    ).toBe(400);
    const canonicalCursorPage = await application.inject({
      method: 'GET',
      url: '/api/v1/jobs?limit=1&scheduledAfter=2025-01-01T00%3A00%3A00Z',
      headers,
    });
    const canonicalCursor = canonicalCursorPage.json<{ data: { nextCursor: string } }>().data
      .nextCursor;
    const equivalentFilterPage = await application.inject({
      method: 'GET',
      url: `/api/v1/jobs?limit=1&scheduledAfter=2025-01-01T00%3A00%3A00.000Z&cursor=${encodeURIComponent(canonicalCursor)}`,
      headers,
    });
    expect(equivalentFilterPage.statusCode).toBe(200);
    expect(
      equivalentFilterPage.json<{ data: { items: { id: string }[] } }>().data.items[0]?.id,
    ).toBe(jobIds[0]);
    const filtered = await application.inject({
      method: 'GET',
      url: `/api/v1/jobs?providerAccountId=${foreignProviderAccountId}`,
      headers,
    });
    expect(filtered.json<{ data: { items: unknown[] } }>().data.items).toEqual([]);
    requireCapability.mockRejectedValueOnce(new ApiKeyAuthorizationError('Missing capability'));
    expect(
      (await application.inject({ method: 'GET', url: '/api/v1/jobs', headers })).statusCode,
    ).toBe(403);
  });
  it.each(['/api/v1/posts/not-a-uuid', '/api/v1/jobs/not-a-uuid'])(
    'returns the stable validation envelope for invalid detail path %s',
    async (url) => {
      const response = await application.inject({
        method: 'GET',
        url,
        headers: {
          authorization: 'Bearer pr_test.secret',
          'x-publish-relay-workspace': workspaceId,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json<{
        success: boolean;
        error: { code: string; requestId: string };
      }>();
      expect(body).toMatchObject({
        success: false,
        error: { code: 'invalid_request' },
      });
      expect(typeof body.error.requestId).toBe('string');
    },
  );

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

describe('CLI and direct HTTP parity', () => {
  const headers = {
    authorization: 'Bearer pr_test.secret',
    'x-publish-relay-workspace': workspaceId,
  };

  it('shares account-scoped X length admission across API, browser, and CLI', async () => {
    await database.exec(
      `UPDATE provider_accounts SET destination_provider = 'x' WHERE id = '${providerAccountId}'`,
    );
    const payload = requestPayload('x'.repeat(281));
    const apiHeaders = { ...headers, 'idempotency-key': 'x-length-api-rejected' };
    const browserHeaders = {
      cookie: `publish_relay_session=${workspaceId}.browser-token; publish_relay_csrf=browser-csrf`,
      'x-csrf-token': 'browser-csrf',
      'idempotency-key': 'x-length-browser-rejected',
    };
    const rejectedApi = await application.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: apiHeaders,
      payload,
    });
    const rejectedBrowser = await application.inject({
      method: 'POST',
      url: '/api/workflow/posts',
      headers: browserHeaders,
      payload,
    });
    expect(rejectedApi.statusCode).toBe(400);
    expect(rejectedBrowser.statusCode).toBe(400);
    await database.exec(
      `UPDATE provider_accounts SET x_long_posts_allowed = true WHERE id = '${providerAccountId}'`,
    );
    const directory = await mkdtemp(join(tmpdir(), 'publish-relay-x-length-'));
    temporaryDirectories.push(directory);
    const bodyFile = join(directory, 'body.json');
    await writeFile(bodyFile, JSON.stringify(payload));
    const acceptedApi = await application.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: { ...apiHeaders, 'idempotency-key': 'x-length-api-accepted' },
      payload,
    });
    const acceptedBrowser = await application.inject({
      method: 'POST',
      url: '/api/workflow/posts',
      headers: { ...browserHeaders, 'idempotency-key': 'x-length-browser-accepted' },
      payload,
    });
    const acceptedCli = await runCli([
      'posts',
      'create',
      '--require-workspace',
      workspaceId,
      '--idempotency-key',
      'x-length-cli-accepted',
      '--body-file',
      bodyFile,
    ]);
    expect(acceptedApi.statusCode).toBe(201);
    expect(acceptedBrowser.statusCode).toBe(201);
    expect(acceptedCli.code).toBe(0);
  });

  it('admits destination-first X threads consistently at the account limit', async () => {
    await database.exec(
      `UPDATE provider_accounts SET destination_provider = 'x' WHERE id = '${providerAccountId}'`,
    );
    const payload = {
      destination: { provider: 'x', providerAccountId },
      content: { schemaVersion: 1, kind: 'thread', posts: ['Opening', 'x'.repeat(272)] },
      scheduledAt: '2026-09-02T10:00:00.000Z',
    };
    const browserHeaders = {
      cookie: `publish_relay_session=${workspaceId}.browser-token; publish_relay_csrf=browser-csrf`,
      'x-csrf-token': 'browser-csrf',
    };
    const directory = await mkdtemp(join(tmpdir(), 'publish-relay-x-thread-'));
    temporaryDirectories.push(directory);
    const bodyFile = join(directory, 'body.json');
    await writeFile(bodyFile, JSON.stringify(payload));
    const createApi = (key: string, body = payload) =>
      application.inject({
        method: 'POST',
        url: '/api/v1/posts',
        headers: { ...headers, 'idempotency-key': key },
        payload: body,
      });
    const createBrowser = (key: string, body = payload) =>
      application.inject({
        method: 'POST',
        url: '/api/workflow/posts',
        headers: { ...browserHeaders, 'idempotency-key': key },
        payload: body,
      });
    const createCli = (key: string) =>
      runCli([
        'posts',
        'create',
        '--require-workspace',
        workspaceId,
        '--idempotency-key',
        key,
        '--body-file',
        bodyFile,
      ]);
    const standard = {
      ...payload,
      content: { ...payload.content, posts: ['Opening', 'x'.repeat(271)] },
    };
    await writeFile(bodyFile, JSON.stringify(standard));
    expect((await createApi('x-thread-api-280', standard)).statusCode).toBe(201);
    expect((await createBrowser('x-thread-browser-280', standard)).statusCode).toBe(201);
    expect((await createCli('x-thread-cli-280')).code).toBe(0);
    await writeFile(bodyFile, JSON.stringify(payload));
    expect((await createApi('x-thread-api-standard')).statusCode).toBe(400);
    expect((await createBrowser('x-thread-browser-standard')).statusCode).toBe(400);
    expect((await createCli('x-thread-cli-standard')).code).not.toBe(0);
    await database.exec(
      `UPDATE provider_accounts SET x_long_posts_allowed = true WHERE id = '${providerAccountId}'`,
    );
    expect((await createApi('x-thread-api-declared')).statusCode).toBe(201);
    expect((await createBrowser('x-thread-browser-declared')).statusCode).toBe(201);
    expect((await createCli('x-thread-cli-declared')).code).toBe(0);
    const maximum = {
      ...payload,
      content: { ...payload.content, posts: ['Opening', 'x'.repeat(24_991)] },
    };
    await writeFile(bodyFile, JSON.stringify(maximum));
    expect((await createApi('x-thread-api-25k', maximum)).statusCode).toBe(201);
    expect((await createBrowser('x-thread-browser-25k', maximum)).statusCode).toBe(201);
    expect((await createCli('x-thread-cli-25k')).code).toBe(0);
    const overLimit = {
      ...payload,
      content: { ...payload.content, posts: ['Opening', 'x'.repeat(24_992)] },
    };
    await writeFile(bodyFile, JSON.stringify(overLimit));
    expect((await createApi('x-thread-api-over', overLimit)).statusCode).toBe(400);
    expect((await createBrowser('x-thread-browser-over', overLimit)).statusCode).toBe(400);
    expect((await createCli('x-thread-cli-over')).code).not.toBe(0);
  });

  it('returns the same stable create envelope, including idempotent replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'publish-relay-cli-parity-'));
    temporaryDirectories.push(directory);
    const bodyFile = join(directory, 'body.json');
    await writeFile(bodyFile, JSON.stringify(requestPayload()));
    const direct = await application.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: { ...headers, 'idempotency-key': 'cli-parity-create' },
      payload: requestPayload(),
    });
    const throughCli = await runCli([
      'posts',
      'create',
      '--require-workspace',
      workspaceId,
      '--idempotency-key',
      'cli-parity-create',
      '--body-file',
      bodyFile,
    ]);

    expect(direct.statusCode).toBe(201);
    expect(throughCli.code).toBe(0);
    expect(stableEnvelope(throughCli.body)).toEqual(stableEnvelope(direct.json()));

    const createdBody = direct.json<{ data: { links: { jobs: string[] } } }>();
    const jobPath = createdBody.data.links.jobs[0];
    if (!jobPath) throw new Error('Expected a publication job link');
    const jobId = jobPath.split('/').at(-1);
    if (!jobId) throw new Error('Expected a publication job ID');
    const directJob = await application.inject({ method: 'GET', url: jobPath, headers });
    const cliJob = await runCli(['publishes', 'show', jobId]);
    expect(directJob.statusCode).toBe(200);
    expect(cliJob.code).toBe(0);
    expect(directJob.body).not.toContain('needsAttention');
    expect(directJob.body).not.toContain('providerRequestId');
    expect(stableEnvelope(cliJob.body)).toEqual(stableEnvelope(directJob.json()));

    const mismatch = await runCli([
      'posts',
      'create',
      '--require-workspace',
      foreignWorkspaceId,
      '--idempotency-key',
      'cli-parity-wrong-workspace',
      '--body-file',
      bodyFile,
    ]);
    expect(mismatch.code).toBe(4);
    expect(mismatch.body).toMatchObject({
      success: false,
      error: { code: 'workspace_mismatch' },
    });
  });

  it.each([
    [
      'invalid cursor',
      '/api/v1/posts?cursor=malformed',
      ['posts', 'list', '--cursor', 'malformed'],
      400,
      5,
    ],
    [
      'missing resource',
      `/api/v1/posts/${missingResourceId}`,
      ['posts', 'show', missingResourceId],
      404,
      5,
    ],
    [
      'missing publication job',
      `/api/v1/jobs/${missingResourceId}`,
      ['publishes', 'show', missingResourceId],
      404,
      5,
    ],
  ])('matches %s envelopes and exits', async (_name, url, command, status, exit) => {
    const direct = await application.inject({ method: 'GET', url, headers });
    const throughCli = await runCli(command);
    expect(direct.statusCode).toBe(status);
    expect(throughCli.code).toBe(exit);
    expect(stableEnvelope(throughCli.body)).toEqual(stableEnvelope(direct.json()));
  });

  it.each([
    ['post', `/api/v1/posts/${foreignPostId}`, ['posts', 'show', foreignPostId]],
    ['publication job', `/api/v1/jobs/${foreignJobId}`, ['publishes', 'show', foreignJobId]],
  ])('hides a foreign-workspace %s through HTTP and CLI', async (_name, url, command) => {
    const direct = await application.inject({ method: 'GET', url, headers });
    const throughCli = await runCli(command);

    expect(direct.statusCode).toBe(404);
    expect(throughCli.code).toBe(5);
    expect(stableEnvelope(throughCli.body)).toEqual(stableEnvelope(direct.json()));
    expect(JSON.stringify(direct.json())).not.toContain('Foreign tenant secret');
    expect(JSON.stringify(throughCli.body)).not.toContain(foreignWorkspaceId);
    expect(JSON.stringify(throughCli.body)).not.toContain(foreignProviderAccountId);
  });

  it('matches capability denial without leaking the key', async () => {
    requireCapability.mockRejectedValue(new ApiKeyAuthorizationError('denied'));
    const direct = await application.inject({ method: 'GET', url: '/api/v1/posts', headers });
    const throughCli = await runCli(['posts', 'list']);
    expect(direct.statusCode).toBe(403);
    expect(throughCli.code).toBe(4);
    expect(stableEnvelope(throughCli.body)).toEqual(stableEnvelope(direct.json()));
    expect(JSON.stringify(throughCli.body)).not.toContain('pr_test.secret');
  });

  it.each(['revoked-key', 'expired-key'])('matches rejected %s authentication', async (key) => {
    authenticate.mockResolvedValue(null);
    const requestHeaders = { ...headers, authorization: `Bearer ${key}` };
    const direct = await application.inject({
      method: 'GET',
      url: '/api/v1/posts',
      headers: requestHeaders,
    });
    const throughCli = await runCli(['posts', 'list'], key);
    expect(direct.statusCode).toBe(401);
    expect(throughCli.code).toBe(3);
    expect(stableEnvelope(throughCli.body)).toEqual(stableEnvelope(direct.json()));
    expect(JSON.stringify(throughCli.body)).not.toContain(key);
  });

  it('matches idempotency conflict', async () => {
    const mutationHeaders = { ...headers, 'idempotency-key': 'cli-parity-conflict' };
    expect(
      (
        await application.inject({
          method: 'POST',
          url: '/api/v1/posts',
          headers: mutationHeaders,
          payload: requestPayload(),
        })
      ).statusCode,
    ).toBe(201);
    const directory = await mkdtemp(join(tmpdir(), 'publish-relay-cli-conflict-'));
    temporaryDirectories.push(directory);
    const bodyFile = join(directory, 'body.json');
    await writeFile(bodyFile, JSON.stringify(requestPayload('Changed content')));
    const direct = await application.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: mutationHeaders,
      payload: requestPayload('Changed content'),
    });
    const throughCli = await runCli([
      'posts',
      'create',
      '--require-workspace',
      workspaceId,
      '--idempotency-key',
      'cli-parity-conflict',
      '--body-file',
      bodyFile,
    ]);
    expect(direct.statusCode).toBe(409);
    expect(throughCli.code).toBe(6);
    expect(stableEnvelope(throughCli.body)).toEqual(stableEnvelope(direct.json()));
  });

  it('matches read rate limiting', async () => {
    for (let index = 0; index < 10; index += 1)
      expect(
        (await application.inject({ method: 'GET', url: '/api/v1/posts', headers })).statusCode,
      ).toBe(200);
    const direct = await application.inject({ method: 'GET', url: '/api/v1/posts', headers });
    const throughCli = await runCli(['posts', 'list']);
    expect(direct.statusCode).toBe(429);
    expect(throughCli.code).toBe(7);
    expect(stableEnvelope(throughCli.body)).toEqual(stableEnvelope(direct.json()));
  });

  it('preserves the job DTO while redacting an injected nested field', async () => {
    application.addHook('preSerialization', (_request, _reply, payload, done) => {
      const envelope = payload as { data?: Record<string, unknown> };
      done(null, {
        ...envelope,
        ...(envelope.data
          ? { data: { ...envelope.data, diagnostic: { accessToken: 'provider-secret' } } }
          : {}),
      });
    });
    const created = await application.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: { ...headers, 'idempotency-key': 'cli-parity-redaction' },
      payload: requestPayload(),
    });
    const jobPath = created.json<{ data: { links: { jobs: string[] } } }>().data.links.jobs[0];
    if (!jobPath) throw new Error('Expected a publication job link');
    const jobId = jobPath.split('/').at(-1);
    if (!jobId) throw new Error('Expected a publication job ID');

    const direct = await application.inject({ method: 'GET', url: jobPath, headers });
    const throughCli = await runCli(['publishes', 'show', jobId]);
    const directBody = stableEnvelope(direct.json());
    const directData = directBody.data as Record<string, unknown>;
    directData.diagnostic = '[REDACTED]';
    expect(throughCli.code).toBe(0);
    expect(stableEnvelope(throughCli.body)).toEqual(directBody);
    expect(JSON.stringify(throughCli.body)).not.toContain('provider-secret');
  });
});

describe('agent publication retry PostgreSQL boundary', () => {
  const headers = {
    authorization: 'Bearer pr_test.secret',
    'x-publish-relay-workspace': workspaceId,
    'idempotency-key': 'retry-job-1',
  };
  const postId = '00000000-0000-4000-8000-000000000821';
  const revisionId = '00000000-0000-4000-8000-000000000822';
  const jobId = '00000000-0000-4000-8000-000000000823';

  async function seedJob(
    input: {
      postId?: string;
      revisionId?: string;
      jobId?: string;
      state?: string;
      reconciliationRequired?: boolean;
    } = {},
  ) {
    const targetPostId = input.postId ?? postId;
    const targetRevisionId = input.revisionId ?? revisionId;
    const targetJobId = input.jobId ?? jobId;
    await database.exec(`
      INSERT INTO posts (id, workspace_id, created_by_user_id)
      VALUES ('${targetPostId}', '${workspaceId}', '${userId}');
      INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
      VALUES ('${targetRevisionId}', '${workspaceId}', '${targetPostId}', 1, '{}');
      INSERT INTO publication_jobs (
        id, workspace_id, post_id, revision_id, provider_account_id, state,
        reconciliation_required, scheduled_at
      ) VALUES (
        '${targetJobId}', '${workspaceId}', '${targetPostId}', '${targetRevisionId}',
        '${providerAccountId}', '${input.state ?? 'failed'}',
        ${input.reconciliationRequired ? 'true' : 'false'}, now()
      );
    `);
  }

  it('retries through delegated publish scope with grant event attribution', async () => {
    await seedJob();
    authenticate.mockResolvedValue(null);
    authenticateDelegated.mockResolvedValue({
      grantId: delegatedGrantId,
      workspaceId,
      userId,
      clientId: 'example-client-local',
      scopes: ['publishes:retry'],
    });
    const response = await application.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/retry`,
      headers: { ...headers, authorization: 'Bearer delegated-token' },
    });
    expect(response.statusCode).toBe(202);
    const event = await database.query<{ actor_type: string; actor_id: string }>(`
      SELECT metadata->>'actorType' AS actor_type, metadata->>'actorId' AS actor_id
      FROM publication_job_events
      WHERE job_id = '${jobId}' AND reason = 'operator_retry'
    `);
    expect(event.rows).toEqual([{ actor_type: 'delegated', actor_id: delegatedGrantId }]);
    expect(evaluateAction).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { type: 'delegated', id: delegatedGrantId } }),
    );
  });

  it('does not requeue an existing job after its server adapter is disabled', async () => {
    await seedJob();
    enabledAdapters.clear();
    const response = await application.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/retry`,
      headers,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'adapter_disabled', message: 'This adapter is disabled on this server' },
    });
    const stored = await database.query<{ state: string; events: number }>(`
      SELECT job.state,
        (SELECT count(*)::int FROM publication_job_events event
          WHERE event.job_id = job.id AND event.reason = 'operator_retry') AS events
      FROM publication_jobs job WHERE job.id = '${jobId}'
    `);
    expect(stored.rows).toEqual([{ state: 'failed', events: 0 }]);
  });

  it('requires authentication and publishes:retry capability', async () => {
    authenticate.mockResolvedValueOnce(null);
    expect(
      (await application.inject({ method: 'POST', url: `/api/v1/jobs/${jobId}/retry`, headers }))
        .statusCode,
    ).toBe(401);
    requireCapability.mockRejectedValueOnce(new ApiKeyAuthorizationError('Missing capability'));
    const denied = await application.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/retry`,
      headers,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      success: false,
      error: { code: 'missing_capability', message: 'Missing capability' },
    });
  });

  it('rejects malformed job and idempotency identities before mutation', async () => {
    expect(
      (
        await application.inject({
          method: 'POST',
          url: '/api/v1/jobs/not-a-uuid/retry',
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await application.inject({
          method: 'POST',
          url: `/api/v1/jobs/${jobId}/retry`,
          headers: { ...headers, 'idempotency-key': '' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('transitions once with exact API-key policy and event attribution', async () => {
    await seedJob();
    const response = await application.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/retry`,
      headers,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        id: jobId,
        state: 'retry_wait',
        links: { self: `/api/v1/jobs/${jobId}` },
      },
    });
    expect(Object.keys(response.json<{ data: object }>().data).sort()).toEqual([
      'id',
      'links',
      'state',
    ]);
    expect(evaluateAction).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        actor: { type: 'api-key', id: apiKeyId },
        action: 'publication.retry',
      }),
    );
    const state = await database.query<{ state: string; actor_type: string; actor_id: string }>(`
      SELECT j.state, e.metadata->>'actorType' AS actor_type, e.metadata->>'actorId' AS actor_id
      FROM publication_jobs j
      JOIN publication_job_events e ON e.job_id = j.id
      WHERE j.id = '${jobId}' AND e.reason = 'operator_retry'
    `);
    expect(state.rows).toEqual([
      { state: 'retry_wait', actor_type: 'api-key', actor_id: apiKeyId },
    ]);
    const replay = await application.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/retry`,
      headers,
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    const events = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM publication_job_events
      WHERE job_id = '${jobId}' AND reason = 'operator_retry'
    `);
    expect(events.rows[0]?.count).toBe(1);

    const browserJobId = '00000000-0000-4000-8000-000000000853';
    await seedJob({
      postId: '00000000-0000-4000-8000-000000000851',
      revisionId: '00000000-0000-4000-8000-000000000852',
      jobId: browserJobId,
    });
    const browserRetry = await application.inject({
      method: 'POST',
      url: `/api/workflow/jobs/${browserJobId}/retry`,
      headers: {
        cookie: `publish_relay_session=${workspaceId}.browser-token; publish_relay_csrf=retry-csrf`,
        'x-csrf-token': 'retry-csrf',
        'idempotency-key': 'browser-retry-user-attribution',
      },
    });
    expect(browserRetry.statusCode).toBe(200);
    const browserEvent = await database.query<{ actor_type: string; actor_id: string }>(`
      SELECT metadata->>'actorType' AS actor_type, metadata->>'actorId' AS actor_id
      FROM publication_job_events
      WHERE job_id = '${browserJobId}' AND reason = 'operator_retry'
    `);
    expect(browserEvent.rows).toEqual([{ actor_type: 'user', actor_id: userId }]);
  });

  it('conflicts without mutation for foreign, non-failed, and unknown-outcome jobs', async () => {
    const scheduledJobId = '00000000-0000-4000-8000-000000000833';
    const unknownJobId = '00000000-0000-4000-8000-000000000843';
    await seedJob({
      postId: '00000000-0000-4000-8000-000000000831',
      revisionId: '00000000-0000-4000-8000-000000000832',
      jobId: scheduledJobId,
      state: 'scheduled',
    });
    await seedJob({
      postId: '00000000-0000-4000-8000-000000000841',
      revisionId: '00000000-0000-4000-8000-000000000842',
      jobId: unknownJobId,
      reconciliationRequired: true,
    });
    for (const [candidateJobId, key] of [
      [foreignJobId, 'retry-foreign'],
      [scheduledJobId, 'retry-scheduled'],
      [unknownJobId, 'retry-unknown'],
    ] as const) {
      const response = await application.inject({
        method: 'POST',
        url: `/api/v1/jobs/${candidateJobId}/retry`,
        headers: { ...headers, 'idempotency-key': key },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'retry_conflict' } });
    }
    const rows = await database.query<{
      id: string;
      state: string;
      reconciliation_required: boolean;
    }>(`
      SELECT id, state, reconciliation_required FROM publication_jobs
      WHERE id IN ('${scheduledJobId}', '${unknownJobId}') ORDER BY id
    `);
    expect(rows.rows).toEqual([
      { id: scheduledJobId, state: 'scheduled', reconciliation_required: false },
      { id: unknownJobId, state: 'failed', reconciliation_required: true },
    ]);
    const events = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM publication_job_events
      WHERE job_id IN ('${scheduledJobId}', '${unknownJobId}')
    `);
    expect(events.rows[0]?.count).toBe(0);
  });

  it('rate limits mutations and conflicts when a key fingerprint changes', async () => {
    await seedJob();
    expect(
      (
        await application.inject({
          method: 'POST',
          url: `/api/v1/jobs/${jobId}/retry`,
          headers: { ...headers, 'idempotency-key': 'shared-retry-key' },
        })
      ).statusCode,
    ).toBe(202);
    const changed = await application.inject({
      method: 'POST',
      url: `/api/v1/jobs/${foreignJobId}/retry`,
      headers: { ...headers, 'idempotency-key': 'shared-retry-key' },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ error: { code: 'idempotency_conflict' } });
    for (let index = 2; index < 10; index += 1)
      await application.inject({
        method: 'POST',
        url: `/api/v1/jobs/${foreignJobId}/retry`,
        headers: { ...headers, 'idempotency-key': `rate-${String(index)}` },
      });
    const limited = await application.inject({
      method: 'POST',
      url: `/api/v1/jobs/${foreignJobId}/retry`,
      headers: { ...headers, 'idempotency-key': 'rate-limited' },
    });
    expect(limited.statusCode).toBe(429);
  });
});
