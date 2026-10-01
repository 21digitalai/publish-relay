import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalMediaStorage } from '../src/modules/content/local-media-storage.js';
import { evaluateMediaRetention } from '../src/modules/content/media-retention.service.js';
import { registerTikTokMediaRoutes } from '../src/modules/providers/tiktok-media.routes.js';
import { TikTokMediaGrantService } from '../src/modules/providers/tiktok-media-grant.service.js';

const migrations = [
  '0000_identity_tenancy',
  '0001_solid_spiral',
  '0002_busy_mantis',
  '0003_many_marvel_boy',
  '0004_easy_doctor_spectrum',
  '0005_round_thunderball',
  '0006_enforce_content_workspace_foreign_keys',
  '0007_add_scheduler_attempt_ledger',
  '0008_handy_shen',
  '0009_generalize_oauth_transaction_secret',
  '0016_common_barracuda',
  '0019_media_retention_lifecycle',
  '0024_mp4_media_metadata',
  '0025_lucky_legion',
  '0045_meta_destination_foundation',
  '0046_linkedin_connection_expiry',
  '0047_linkedin_member_connections',
  '0048_reconcile_linkedin_connections',
  '0049_meta_effective_payload',
  '0051_provider_subject_lifecycle',
  '0052_provider_capability_snapshots',
  '0053_publication_consents',
  '0054_tiktok_media_grants',
];
const workspaceId = '00000000-0000-4000-8000-000000000101';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000201';
const accountId = '00000000-0000-4000-8000-000000000501';
const connectionId = '00000000-0000-4000-8000-000000000601';
const credentialId = '00000000-0000-4000-8000-000000000701';
const mediaId = '00000000-0000-4000-8000-000000000401';
const bytes = Buffer.from('0123456789abcdef');
const sha256 = createHash('sha256').update(bytes).digest('hex');
let pg: PGlite;
let db: NodePgDatabase;
let storage: LocalMediaStorage;
let storageRoot: string;
let service: TikTokMediaGrantService;
let storageKey: string;

function issue(workspace = workspaceId) {
  return service.issue({
    workspaceId: workspace,
    accountId,
    mediaId,
    publicOrigin: 'https://media.example.test',
  });
}

function tokenFromUrl(url: string): string {
  return new URL(url).pathname.split('/').at(-1) ?? '';
}

function app() {
  const server = Fastify({ trustProxy: true });
  registerTikTokMediaRoutes(server, { grants: service, mediaStorage: storage });
  return server;
}

beforeEach(async () => {
  pg = new PGlite();
  for (const migration of migrations)
    await pg.exec(
      await readFile(new URL(`../migrations/${migration}.sql`, import.meta.url), 'utf8'),
    );
  db = drizzle(pg) as unknown as NodePgDatabase;
  storageRoot = await mkdtemp(join(tmpdir(), 'relay-tiktok-pull-'));
  storage = new LocalMediaStorage(storageRoot);
  storageKey = (await storage.put({ workspaceId, mediaId, bytes, mimeType: 'video/mp4' }))
    .storageKey;
  service = new TikTokMediaGrantService(db, Buffer.alloc(32, 7));
  await pg.exec(`
    insert into workspaces (id, name, slug) values
      ('${workspaceId}', 'One', 'one'), ('${otherWorkspaceId}', 'Two', 'two');
    insert into credentials (id, workspace_id, key_version, wrapped_key,
      wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
      values ('${credentialId}', '${workspaceId}', 'fixture', '\\x01', '\\x01',
      '\\x01', '\\x01', '\\x01', '\\x01');
    insert into provider_connections (id, workspace_id, provider, external_subject_id,
      credential_id, scopes, refresh_expires_at)
      values ('${connectionId}', '${workspaceId}', 'tiktok', 'subject-one',
      '${credentialId}', '["video.publish"]', now() + interval '1 day');
    insert into provider_accounts (id, workspace_id, connection_id, provider_account_id,
      destination_provider, remote_account_id, display_name)
      values ('${accountId}', '${workspaceId}', '${connectionId}', 'subject-one',
      'tiktok', 'subject-one', 'One');
    insert into media_objects (id, workspace_id, storage_key, sha256, mime_type,
      byte_size, duration_ms, width, height, video_codec, container, state, retained_at)
      values ('${mediaId}', '${workspaceId}', '${storageKey}', '${sha256}',
      'video/mp4', ${String(bytes.length)}, 30000, 1080, 1920, 'h264', 'mp4', 'ready', now());
  `);
});

afterEach(async () => {
  await pg.close();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('TikTok scoped pull grant', () => {
  it('persists an opaque 90+ minute grant before delivery and denies cross-tenant issuance', async () => {
    const grant = await issue();
    expect(grant.expiresAt.getTime()).toBeGreaterThan(Date.now() + 90 * 60 * 1000);
    expect(grant.url).not.toContain(workspaceId);
    expect(grant.url).not.toContain(mediaId);
    expect(await service.resolve(grant.id, tokenFromUrl(grant.url))).not.toBeNull();
    await expect(issue(otherWorkspaceId)).rejects.toThrow('unavailable');
    const rows = await pg.query<{ token_hash: string }>(
      'select token_hash from provider_media_grants',
    );
    expect(rows.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(grant.url).not.toContain(rows.rows[0]?.token_hash ?? 'missing-hash');
  });

  it('serves verified GET, HEAD, and single byte ranges without redirecting', async () => {
    const grant = await issue();
    const server = app();
    const path = new URL(grant.url).pathname;
    const headers = { 'x-forwarded-proto': 'https' };
    const get = await server.inject({ method: 'GET', url: path, headers });
    expect(get.statusCode).toBe(200);
    expect(get.body).toBe(bytes.toString());
    expect(get.headers['content-type']).toContain('video/mp4');
    expect(get.headers.location).toBeUndefined();
    const head = await server.inject({ method: 'HEAD', url: path, headers });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(String(bytes.length));
    const range = await server.inject({
      method: 'GET',
      url: path,
      headers: { ...headers, range: 'bytes=2-5' },
    });
    expect(range.statusCode).toBe(206);
    expect(range.body).toBe('2345');
    expect(range.headers['content-range']).toBe(`bytes 2-5/${String(bytes.length)}`);
    const suffix = await server.inject({
      method: 'GET',
      url: path,
      headers: { ...headers, range: 'bytes=-4' },
    });
    expect(suffix.body).toBe('cdef');
    const invalid = await server.inject({
      method: 'GET',
      url: path,
      headers: { ...headers, range: 'bytes=0-1,4-5' },
    });
    expect(invalid.statusCode).toBe(416);
    expect((await server.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    await server.close();
  });

  it('rejects expired, revoked, tampered, missing, and altered media grants', async () => {
    const grant = await issue();
    const token = tokenFromUrl(grant.url);
    expect(await service.resolve(grant.id, `${token}x`)).toBeNull();
    expect(await service.resolve(randomUUID(), token)).toBeNull();
    expect(await service.resolve(grant.id, token, grant.expiresAt)).toBeNull();
    const server = app();
    const path = new URL(grant.url).pathname;
    const headers = { 'x-forwarded-proto': 'https' };
    await storage.delete(storageKey);
    expect((await server.inject({ method: 'GET', url: path, headers })).statusCode).toBe(404);
    await writeFile(join(storageRoot, storageKey), Buffer.from('altered-data-xxx'));
    expect((await server.inject({ method: 'GET', url: path, headers })).statusCode).toBe(404);
    expect(
      await service.revoke({ workspaceId: otherWorkspaceId, accountId, grantId: grant.id }),
    ).toBe(false);
    expect(await service.revoke({ workspaceId, accountId, grantId: grant.id })).toBe(true);
    expect(await service.resolve(grant.id, token)).toBeNull();
    await server.close();
  });

  it('holds canonical retention until revocation and enforces tenant RLS', async () => {
    const grant = await issue();
    const now = new Date();
    expect(
      await evaluateMediaRetention(db, {
        workspaceId,
        now,
        policy: { cleanupDeadline: () => new Date(0) },
      }),
    ).toBe(0);
    await pg.exec(`create role pull_reader nologin nobypassrls;
      grant select on provider_media_grants to pull_reader;`);
    await pg.exec(`begin;
      set local role pull_reader;
      select set_config('app.workspace_id', '${otherWorkspaceId}', true);`);
    const denied = await pg.query('select id from provider_media_grants');
    expect(denied.rows).toHaveLength(0);
    await pg.exec(`select set_config('app.workspace_id', '${workspaceId}', true);`);
    const allowed = await pg.query('select id from provider_media_grants');
    expect(allowed.rows).toHaveLength(1);
    await pg.exec('rollback');
    expect(await service.revoke({ workspaceId, accountId, grantId: grant.id })).toBe(true);
    expect(
      await evaluateMediaRetention(db, {
        workspaceId,
        now: new Date(),
        policy: { cleanupDeadline: () => new Date(0) },
      }),
    ).toBe(1);
  });
});
