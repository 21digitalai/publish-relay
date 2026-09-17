import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PostgresInstagramArtifactStore } from '../src/modules/providers/instagram-artifact-store.js';
import { registerInstagramMediaRoutes } from '../src/modules/providers/instagram-media.routes.js';
import { InstagramMediaTokenCodec } from '../src/modules/providers/instagram-media-token.js';
import { cleanupExpiredStaging } from '../src/modules/content/provider-staging.service.js';
import {
  createFixedMediaRetentionPolicy,
  evaluateMediaRetention,
} from '../src/modules/content/media-retention.service.js';
import { claimDueJobs, startDispatchAttempt } from '../src/modules/scheduler/job.repository.js';

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
  '0025_lucky_legion.sql',
  '0026_parallel_human_cannonball.sql',
  '0027_overjoyed_dark_beast.sql',
  '0037_meta_destination_foundation.sql',
  '0038_meta_effective_payload.sql',
  '0039_instagram_staging_artifacts.sql',
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
  db = drizzle(database) as unknown as NodePgDatabase;
});

afterEach(async () => database.close());

describe('Instagram staging persistence and signed media delivery', () => {
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
      UPDATE publication_jobs SET state = 'cancelled' WHERE id = '${jobId}';
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
        `UPDATE publication_jobs SET state = '${terminalState}' WHERE id = '${jobId}'`,
      );
      const storage = { delete: vi.fn(() => Promise.resolve()) };

      await expect(
        cleanupExpiredStaging(db, storage, {
          workspaceId: workspaceA,
          expiredBefore: new Date(now.getTime() + 25 * 60 * 60 * 1000),
          now: new Date(now.getTime() + 25 * 60 * 60 * 1000),
        }),
      ).resolves.toBe(1);
      expect(storage.delete).toHaveBeenCalledWith('instagram:job:child:0');
      const rows = await database.query<{ count: number; deleted_at: Date | null }>(
        `SELECT count(*)::int AS count, max(deleted_at) AS deleted_at
         FROM provider_staging_artifacts WHERE artifact_key = 'instagram:job:child:0'`,
      );
      expect(rows.rows[0]?.count).toBe(1);
      expect(rows.rows[0]?.deleted_at).not.toBeNull();
    },
  );

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
