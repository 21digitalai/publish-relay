import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { credentials } from '../src/database/schema.js';
import { encryptCredential, type MasterKeyProvider } from '../src/modules/credentials/envelope.js';
import { dispatchDueLinkedInJobs } from '../src/modules/providers/linkedin-dispatch.service.js';
import { LinkedInHttpClient } from '../src/modules/providers/linkedin-http-client.js';

import { PostgresInstagramArtifactStore } from '../src/modules/providers/instagram-artifact-store.js';
import { PostgresLinkedInVideoArtifactStore } from '../src/modules/providers/linkedin-video-artifact-store.js';
import { registerInstagramMediaRoutes } from '../src/modules/providers/instagram-media.routes.js';
import { InstagramMediaTokenCodec } from '../src/modules/providers/instagram-media-token.js';
import { cleanupExpiredStaging } from '../src/modules/content/provider-staging.service.js';
import { runProviderStagingCleanupCycle } from '../src/modules/content/provider-staging.worker.js';
import {
  createFixedMediaRetentionPolicy,
  evaluateMediaRetention,
} from '../src/modules/content/media-retention.service.js';
import {
  claimDueJobs,
  deferLeasedJob,
  startDispatchAttempt,
} from '../src/modules/scheduler/job.repository.js';

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
  '0014_great_lethal_legion.sql',
  '0015_talented_alex_power.sql',
  '0016_common_barracuda.sql',
  '0019_media_retention_lifecycle.sql',
  '0024_mp4_media_metadata.sql',
  '0025_lucky_legion.sql',
  '0026_parallel_human_cannonball.sql',
  '0027_overjoyed_dark_beast.sql',
  '0045_meta_destination_foundation.sql',
  '0048_reconcile_linkedin_connections.sql',
  '0049_meta_effective_payload.sql',
  '0050_instagram_staging_artifacts.sql',
  '0051_provider_subject_lifecycle.sql',
  '0054_tiktok_media_grants.sql',
  '0055_x_long_post_declaration.sql',
  '0056_meta_grant_family.sql',
  '0077_publication_attempt_external_url.sql',
  '0078_tiktok_one_shot_init.sql',
] as const;

const workspaceA = '00000000-0000-4000-8000-000000000401';
const workspaceB = '00000000-0000-4000-8000-000000000402';
const userId = '00000000-0000-4000-8000-000000000403';
const jobId = '00000000-0000-4000-8000-000000000409';
const mediaId = '00000000-0000-4000-8000-000000000410';
let database: PGlite;
let db: NodePgDatabase;

beforeEach(async () => {
  database = new PGlite();
  for (const migration of migrations)
    await database.exec(
      await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'),
    );
  await database.exec(`
    INSERT INTO workspaces (id, name, slug) VALUES
      ('${workspaceA}', 'Instagram A', 'instagram-a'),
      ('${workspaceB}', 'Instagram B', 'instagram-b');
    INSERT INTO users (id, email, password_hash) VALUES
      ('${userId}', 'instagram@example.test', 'redacted');
    SELECT set_config('app.workspace_id', '${workspaceA}', false);
    INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
      wrapped_key_tag, ciphertext, nonce, tag) VALUES
      ('00000000-0000-4000-8000-000000000404', '${workspaceA}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
    INSERT INTO provider_connections (id, workspace_id, provider, credential_id) VALUES
      ('00000000-0000-4000-8000-000000000405', '${workspaceA}', 'meta', '00000000-0000-4000-8000-000000000404');
    INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id,
      display_name, destination_provider, remote_account_id) VALUES
      ('00000000-0000-4000-8000-000000000406', '${workspaceA}', '00000000-0000-4000-8000-000000000405', 'ig-a', 'Instagram A', 'instagram', 'ig-a');
    INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES
      ('00000000-0000-4000-8000-000000000407', '${workspaceA}', '${userId}');
    INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content) VALUES
      ('00000000-0000-4000-8000-000000000408', '${workspaceA}', '00000000-0000-4000-8000-000000000407', 1, '{"type":"text","text":"Caption"}');
    INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at) VALUES
      ('${jobId}', '${workspaceA}', '00000000-0000-4000-8000-000000000407', '00000000-0000-4000-8000-000000000408', '00000000-0000-4000-8000-000000000406', now());
    INSERT INTO media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size, state) VALUES
      ('${mediaId}', '${workspaceA}', 'instagram/image.jpg', 'hash', 'image/jpeg', 5, 'ready');
    INSERT INTO revision_media (workspace_id, revision_id, media_id, position) VALUES
      ('${workspaceA}', '00000000-0000-4000-8000-000000000408', '${mediaId}', 0);
  `);
  await database.exec(
    await readFile(
      new URL('../migrations/0059_provider_account_exposures.sql', import.meta.url),
      'utf8',
    ),
  );
  db = drizzle(database) as unknown as NodePgDatabase;
});

afterEach(async () => database.close());

describe('Instagram staging persistence and signed media delivery', () => {
  it('persists tenant-bound LinkedIn video phase transitions in the shared artifact ledger', async () => {
    const scope = { workspaceId: workspaceA, jobId, mediaId, memberUrn: 'urn:li:person:member-1' };
    const store = new PostgresLinkedInVideoArtifactStore(db, scope);
    await expect(store.ensure()).resolves.toEqual({ phase: 'reserved', video: null });
    await store.recordUploaded('urn:li:video:video-1');
    const restarted = new PostgresLinkedInVideoArtifactStore(db, scope);
    await expect(restarted.ensure()).resolves.toEqual({
      phase: 'processing',
      video: 'urn:li:video:video-1',
    });
    await expect(store.recordUploaded('urn:li:video:video-2')).rejects.toThrow();
    await expect(store.recordStatus('urn:li:video:foreign', 'AVAILABLE')).rejects.toThrow();
    await store.recordStatus('urn:li:video:video-1', 'AVAILABLE');
    await expect(restarted.ensure()).resolves.toEqual({
      phase: 'available',
      video: 'urn:li:video:video-1',
    });
    await expect(store.recordStatus('urn:li:video:video-1', 'AVAILABLE')).rejects.toThrow();
    const wrongOwner = new PostgresLinkedInVideoArtifactStore(db, {
      ...scope,
      memberUrn: 'urn:li:person:other',
    });
    await expect(wrongOwner.ensure()).rejects.toThrow('identity mismatch');
    const wrongTenant = new PostgresLinkedInVideoArtifactStore(db, {
      ...scope,
      workspaceId: workspaceB,
    });
    await expect(wrongTenant.ensure()).rejects.toThrow();
    const unattached = new PostgresLinkedInVideoArtifactStore(db, {
      ...scope,
      mediaId: '00000000-0000-4000-8000-000000000411',
    });
    await expect(unattached.ensure()).rejects.toThrow('not attached');
  });

  it('waits for LinkedIn video processing before one member post and survives a worker cycle', async () => {
    const memberUrn = 'urn:li:person:member';
    const videoUrn = 'urn:li:video:asset';
    await database.exec(`
      UPDATE provider_connections SET provider = 'linkedin', member_urn = '${memberUrn}',
        external_subject_id = '${memberUrn}', expires_at = '2030-01-01T00:00:00Z'
        WHERE id = '00000000-0000-4000-8000-000000000405';
      UPDATE provider_accounts SET destination_provider = 'linkedin',
        provider_account_id = '${memberUrn}', remote_account_id = '${memberUrn}'
        WHERE id = '00000000-0000-4000-8000-000000000406';
      INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
      VALUES ('00000000-0000-4000-8000-000000000412', '${workspaceA}',
        '00000000-0000-4000-8000-000000000407', 2,
        '{"kind":"video","text":"Watch","title":"Demo"}');
      INSERT INTO revision_media (workspace_id, revision_id, media_id, position)
      VALUES ('${workspaceA}', '00000000-0000-4000-8000-000000000412', '${mediaId}', 0);
      UPDATE publication_jobs SET revision_id = '00000000-0000-4000-8000-000000000412'
        WHERE id = '${jobId}';
      UPDATE media_objects SET mime_type = 'video/mp4', byte_size = 75000,
        duration_ms = 3000, container = 'mp4', video_codec = 'h264', audio_codec = 'aac'
        WHERE id = '${mediaId}';
    `);
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(Buffer.alloc(32, 7)),
    };
    const credential = {
      accessToken: 'fixture-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
      memberUrn,
      scope: 'w_member_social',
    };
    const encrypted = await encryptCredential(Buffer.from(JSON.stringify(credential)), keys);
    await db
      .update(credentials)
      .set(encrypted)
      .where(eq(credentials.id, '00000000-0000-4000-8000-000000000404'));
    const statuses = ['PROCESSING', 'AVAILABLE', 'AVAILABLE'];
    const request = vi.fn<typeof fetch>().mockImplementation((resource, init) => {
      const url =
        typeof resource === 'string'
          ? resource
          : resource instanceof URL
            ? resource.href
            : resource.url;
      if (url.includes('initializeUpload'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              value: {
                video: videoUrn,
                uploadToken: 'upload-token',
                uploadUrlsExpireAt: Date.now() + 300_000,
                uploadInstructions: [
                  {
                    firstByte: 0,
                    lastByte: 74_999,
                    uploadUrl: 'https://www.linkedin.com/upload/fixture',
                  },
                ],
              },
            }),
            { status: 200 },
          ),
        );
      if (init?.method === 'PUT')
        return Promise.resolve(new Response(null, { status: 200, headers: { etag: 'part-1' } }));
      if (url.includes('finalizeUpload'))
        return Promise.resolve(new Response(null, { status: 200 }));
      if (url.includes('/rest/videos/'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: videoUrn,
              owner: memberUrn,
              status: statuses.shift() ?? 'AVAILABLE',
            }),
            { status: 200 },
          ),
        );
      if (url.endsWith('/rest/posts'))
        return Promise.resolve(
          new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:post' } }),
        );
      throw new Error(`Unexpected LinkedIn fixture request: ${url}`);
    });
    const runtime = {
      database: db,
      keys,
      client: new LinkedInHttpClient({
        clientId: 'fixture',
        clientSecret: 'fixture',
        fetch: request,
      }),
      source: {
        load: vi.fn().mockResolvedValue({ bytes: Buffer.alloc(75_000), mimeType: 'video/mp4' }),
      },
      workerId: 'linkedin-fixture',
      leaseMs: 30_000,
    };
    const now = new Date();
    await expect(dispatchDueLinkedInJobs(runtime, now)).resolves.toBe(0);
    const pending = await database.query<{ state: string; count: number }>(`
      SELECT state, (SELECT count(*)::int FROM publication_attempts WHERE job_id = '${jobId}') AS count
      FROM publication_jobs WHERE id = '${jobId}'
    `);
    expect(pending.rows[0]).toMatchObject({ state: 'retry_wait', count: 0 });
    await expect(dispatchDueLinkedInJobs(runtime, new Date(now.getTime() + 30_001))).resolves.toBe(
      1,
    );
    const posted = await database.query<{ state: string; count: number }>(`
      SELECT state, (SELECT count(*)::int FROM publication_attempts WHERE job_id = '${jobId}') AS count
      FROM publication_jobs WHERE id = '${jobId}'
    `);
    expect(posted.rows[0]).toMatchObject({ state: 'published', count: 1 });
    expect(
      request.mock.calls.filter(([url]) =>
        (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith(
          '/rest/posts',
        ),
      ),
    ).toHaveLength(1);
    expect(runtime.source.load).toHaveBeenCalledTimes(1);
  });
  it('allows one Instagram worker claim and rejects lease-lost progression', async () => {
    const now = new Date();
    const [first, second] = await Promise.all([
      claimDueJobs(db, {
        workerId: 'instagram-a',
        now,
        leaseMs: 30_000,
        limit: 1,
        destinationProvider: 'instagram',
        requireMedia: true,
      }),
      claimDueJobs(db, {
        workerId: 'instagram-b',
        now,
        leaseMs: 30_000,
        limit: 1,
        destinationProvider: 'instagram',
        requireMedia: true,
      }),
    ]);
    const claimed = [...first, ...second];
    expect(claimed).toHaveLength(1);
    const owner = first.length === 1 ? 'instagram-a' : 'instagram-b';
    const loser = owner === 'instagram-a' ? 'instagram-b' : 'instagram-a';
    const fingerprint = 'instagram-claim-proof';
    await expect(
      startDispatchAttempt(db, {
        workspaceId: workspaceA,
        jobId,
        workerId: loser,
        fingerprint,
        now,
      }),
    ).resolves.toBeNull();
    await expect(
      startDispatchAttempt(db, {
        workspaceId: workspaceA,
        jobId,
        workerId: owner,
        fingerprint,
        now,
      }),
    ).resolves.toMatchObject({ attemptNumber: 1 });
  });

  it('defers a processing asset only for its live lease owner, without a post attempt', async () => {
    const now = new Date();
    const [claimed] = await claimDueJobs(db, {
      workerId: 'media-owner',
      now,
      leaseMs: 30_000,
      limit: 1,
      destinationProvider: 'instagram',
    });
    expect(claimed?.id).toBe(jobId);
    const retryAt = new Date(now.getTime() + 30_000);
    await expect(
      deferLeasedJob(db, { workspaceId: workspaceA, jobId, workerId: 'other', now, retryAt }),
    ).resolves.toBe(false);
    await expect(
      deferLeasedJob(db, { workspaceId: workspaceA, jobId, workerId: 'media-owner', now, retryAt }),
    ).resolves.toBe(true);
    const rows = await database.query<{ state: string; count: number; attempt_number: number }>(`
      SELECT job.state, job.attempt_number,
        (SELECT count(*)::int FROM publication_attempts WHERE job_id = job.id) AS count
      FROM publication_jobs job WHERE job.id = '${jobId}'
    `);
    expect(rows.rows[0]).toMatchObject({ state: 'retry_wait', attempt_number: 0, count: 0 });
    await expect(
      startDispatchAttempt(db, {
        workspaceId: workspaceA,
        jobId,
        workerId: 'media-owner',
        fingerprint: 'not-posted',
        now,
      }),
    ).resolves.toBeNull();
  });

  it('persists one tenant-bound artifact with a bounded expiry and durable updates', async () => {
    const now = new Date('2026-09-17T16:00:00Z');
    const store = new PostgresInstagramArtifactStore(db, {
      workspaceId: workspaceA,
      jobId,
      now: () => now,
    });

    await expect(
      store.ensure({ key: 'instagram:job:child:0', kind: 'child', mediaId }),
    ).resolves.toMatchObject({ phase: 'initialized', kind: 'child' });
    await expect(
      store.update('instagram:job:child:0', {
        phase: 'created',
        externalObjectId: 'container-1',
      }),
    ).resolves.toMatchObject({ phase: 'created', externalObjectId: 'container-1' });
    const rows = await database.query<{ count: number; expires_at: Date }>(
      `SELECT count(*)::int AS count, max(expires_at) AS expires_at
       FROM provider_staging_artifacts WHERE artifact_key = 'instagram:job:child:0'`,
    );
    expect(rows.rows[0]?.count).toBe(1);
    expect(new Date(rows.rows[0]?.expires_at ?? 0).getTime()).toBe(now.getTime() + 86_400_000);

    const otherTenant = new PostgresInstagramArtifactStore(db, {
      workspaceId: workspaceB,
      jobId,
    });
    await expect(
      otherTenant.ensure({ key: 'instagram:job:child:0', kind: 'child', mediaId }),
    ).rejects.toThrow();

    await database.exec(`
      UPDATE publication_jobs
         SET state = 'cancelled', updated_at = '${now.toISOString()}'
       WHERE id = '${jobId}';
      UPDATE media_objects SET retained_at = '${now.toISOString()}' WHERE id = '${mediaId}';
    `);
    await expect(
      evaluateMediaRetention(db, {
        workspaceId: workspaceA,
        now: new Date(now.getTime() + 60 * 60 * 1000),
        policy: createFixedMediaRetentionPolicy(0),
      }),
    ).resolves.toBe(0);
    await expect(
      evaluateMediaRetention(db, {
        workspaceId: workspaceA,
        now: new Date(now.getTime() + 25 * 60 * 60 * 1000),
        policy: createFixedMediaRetentionPolicy(0),
      }),
    ).resolves.toBe(1);
  });

  it.each(['cancelled', 'superseded'] as const)(
    'expires %s job artifacts after grace while retaining their audit rows',
    async (terminalState) => {
      const now = new Date('2026-09-17T16:00:00Z');
      const store = new PostgresInstagramArtifactStore(db, {
        workspaceId: workspaceA,
        jobId,
        now: () => now,
      });
      await store.ensure({ key: 'instagram:job:child:0', kind: 'child', mediaId });
      await database.exec(
        `UPDATE publication_jobs SET state = '${terminalState}', updated_at = '${now.toISOString()}' WHERE id = '${jobId}'`,
      );
      const genericDeletes: string[] = [];
      await expect(
        cleanupExpiredStaging(
          db,
          {
            delete: (providerReference) =>
              Promise.resolve(void genericDeletes.push(providerReference)),
          },
          {
            workspaceId: workspaceA,
            expiredBefore: new Date(now.getTime() + 25 * 60 * 60 * 1000),
          },
        ),
      ).resolves.toBe(0);
      expect(genericDeletes).toEqual([]);
      await expect(
        runProviderStagingCleanupCycle(
          db,
          { batchSize: 100, terminalGraceMs: 24 * 60 * 60 * 1000 },
          new Date(now.getTime() + 25 * 60 * 60 * 1000),
        ),
      ).resolves.toMatchObject({ instagramDeleted: 1 });
      const rows = await database.query<{ count: number; deleted_at: Date | null }>(
        `SELECT count(*)::int AS count, max(deleted_at) AS deleted_at
         FROM provider_staging_artifacts WHERE artifact_key = 'instagram:job:child:0'`,
      );
      expect(rows.rows[0]?.count).toBe(1);
      expect(rows.rows[0]?.deleted_at).not.toBeNull();
    },
  );

  it.each(['cancelled', 'superseded'] as const)(
    'retains media bytes until a late %s transition has completed its full grace',
    async (terminalState) => {
      const createdAt = new Date('2026-09-17T16:00:00Z');
      const terminalAt = new Date(createdAt.getTime() + 23 * 60 * 60 * 1000);
      const store = new PostgresInstagramArtifactStore(db, {
        workspaceId: workspaceA,
        jobId,
        now: () => createdAt,
      });
      await store.ensure({ key: 'instagram:job:child:0', kind: 'child', mediaId });
      await database.exec(`
        UPDATE publication_jobs
           SET state = '${terminalState}', updated_at = '${terminalAt.toISOString()}'
         WHERE id = '${jobId}';
        UPDATE media_objects
           SET retained_at = '${createdAt.toISOString()}'
         WHERE id = '${mediaId}';
      `);

      await expect(
        evaluateMediaRetention(db, {
          workspaceId: workspaceA,
          now: new Date(createdAt.getTime() + 25 * 60 * 60 * 1000),
          policy: createFixedMediaRetentionPolicy(0),
        }),
      ).resolves.toBe(0);
      await expect(
        database.query<{ state: string }>(
          `SELECT state FROM media_objects WHERE id = '${mediaId}'`,
        ),
      ).resolves.toMatchObject({ rows: [{ state: 'ready' }] });

      await expect(
        evaluateMediaRetention(db, {
          workspaceId: workspaceA,
          now: new Date(terminalAt.getTime() + 25 * 60 * 60 * 1000),
          policy: createFixedMediaRetentionPolicy(0),
        }),
      ).resolves.toBe(1);
      await expect(
        database.query<{ state: string }>(
          `SELECT state FROM media_objects WHERE id = '${mediaId}'`,
        ),
      ).resolves.toMatchObject({ rows: [{ state: 'cleanup_eligible' }] });
    },
  );

  it.each([
    { label: 'scheduled', state: 'scheduled', reconciliationRequired: false },
    { label: 'reconciliation-required', state: 'accepted_pending', reconciliationRequired: true },
  ] as const)(
    'preserves expired Instagram artifacts while the job is $label',
    async ({ state, reconciliationRequired }) => {
      const now = new Date('2026-09-17T16:00:00Z');
      const store = new PostgresInstagramArtifactStore(db, {
        workspaceId: workspaceA,
        jobId,
        now: () => now,
      });
      await store.ensure({ key: 'instagram:job:child:0', kind: 'child', mediaId });
      await database.exec(
        `UPDATE publication_jobs SET state = '${state}', reconciliation_required = ${String(reconciliationRequired)}, updated_at = '${now.toISOString()}' WHERE id = '${jobId}'`,
      );

      await expect(
        runProviderStagingCleanupCycle(
          db,
          { batchSize: 100, terminalGraceMs: 24 * 60 * 60 * 1000 },
          new Date(now.getTime() + 48 * 60 * 60 * 1000),
        ),
      ).resolves.toMatchObject({ instagramDeleted: 0 });
      const rows = await database.query<{ deleted_at: Date | null }>(
        `SELECT deleted_at FROM provider_staging_artifacts WHERE artifact_key = 'instagram:job:child:0'`,
      );
      expect(rows.rows[0]?.deleted_at).toBeNull();
    },
  );

  it('waits a full terminal grace before tombstoning expired Instagram artifacts', async () => {
    const createdAt = new Date('2026-09-17T16:00:00Z');
    const terminalAt = new Date(createdAt.getTime() + 25 * 60 * 60 * 1000);
    const store = new PostgresInstagramArtifactStore(db, {
      workspaceId: workspaceA,
      jobId,
      now: () => createdAt,
    });
    await store.ensure({ key: 'instagram:job:child:0', kind: 'child', mediaId });
    await database.exec(
      `UPDATE publication_jobs SET state = 'cancelled', updated_at = '${terminalAt.toISOString()}' WHERE id = '${jobId}'`,
    );

    await expect(
      runProviderStagingCleanupCycle(
        db,
        { batchSize: 100, terminalGraceMs: 24 * 60 * 60 * 1000 },
        new Date(terminalAt.getTime() + 23 * 60 * 60 * 1000),
      ),
    ).resolves.toMatchObject({ instagramDeleted: 0 });
    await expect(
      runProviderStagingCleanupCycle(
        db,
        { batchSize: 100, terminalGraceMs: 24 * 60 * 60 * 1000 },
        new Date(terminalAt.getTime() + 25 * 60 * 60 * 1000),
      ),
    ).resolves.toMatchObject({ instagramDeleted: 1 });
  });

  it('serves valid signed bytes while rejecting expiry, tampering, and cross-tenant media', async () => {
    const codec = new InstagramMediaTokenCodec(Buffer.alloc(32, 7));
    const application = Fastify();
    registerInstagramMediaRoutes(application, {
      database: db,
      tokenCodec: codec,
      mediaStorage: {
        put: () => Promise.resolve({ storageKey: 'unused' }),
        read: () => Promise.resolve(Buffer.from('image')),
        delete: () => Promise.resolve(),
      },
    });
    const valid = codec.issue({ workspaceId: workspaceA, mediaId, expiresAt: Date.now() + 60_000 });
    const expired = codec.issue({ workspaceId: workspaceA, mediaId, expiresAt: Date.now() - 1 });
    const crossTenant = codec.issue({
      workspaceId: workspaceB,
      mediaId,
      expiresAt: Date.now() + 60_000,
    });

    const route = (token: string) => `/provider-media/instagram?token=${encodeURIComponent(token)}`;
    const response = await application.inject(route(valid));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('image');
    expect(response.headers['cache-control']).toBe('private, no-store');
    await expect(application.inject(route(expired))).resolves.toMatchObject({ statusCode: 404 });
    await expect(application.inject(route(`${valid}x`))).resolves.toMatchObject({
      statusCode: 404,
    });
    await expect(application.inject(route(crossTenant))).resolves.toMatchObject({
      statusCode: 404,
    });
    await application.close();
  });
});
