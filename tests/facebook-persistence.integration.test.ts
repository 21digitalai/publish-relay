import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { credentials } from '../src/database/schema.js';
import { encryptCredential, type MasterKeyProvider } from '../src/modules/credentials/envelope.js';
import { FacebookPublishingAdapter } from '../src/modules/providers/facebook-adapter.js';
import { PostgresFacebookArtifactStore } from '../src/modules/providers/facebook-artifact-store.js';
import {
  reconcileFacebookJobs,
  type FacebookDispatchRuntime,
} from '../src/modules/providers/facebook-dispatch.service.js';
import { FacebookHttpClient } from '../src/modules/providers/facebook-http-client.js';
import {
  claimDueJobs,
  deriveJobIdempotencyKey,
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
  '0025_lucky_legion.sql',
  '0026_parallel_human_cannonball.sql',
  '0027_overjoyed_dark_beast.sql',
  '0045_meta_destination_foundation.sql',
  '0049_meta_effective_payload.sql',
  '0050_instagram_staging_artifacts.sql',
] as const;

const workspaceA = '00000000-0000-4000-8000-000000000701';
const workspaceB = '00000000-0000-4000-8000-000000000702';
const userId = '00000000-0000-4000-8000-000000000703';
const facebookJobId = '00000000-0000-4000-8000-000000000709';
const instagramJobId = '00000000-0000-4000-8000-000000000710';
let database: PGlite;
let db: NodePgDatabase;

class TestKeys implements MasterKeyProvider {
  private readonly key = randomBytes(32);

  public currentVersion(): string {
    return 'v1';
  }

  public getKey(version: string): Promise<Buffer> {
    if (version !== 'v1') throw new Error(`Unknown master key version: ${version}`);
    return Promise.resolve(this.key);
  }
}

function facebookRuntime(keys: MasterKeyProvider, request: typeof fetch): FacebookDispatchRuntime {
  return {
    database: db,
    keys,
    client: new FacebookHttpClient({ graphVersion: 'v23.0', fetch: request }),
    tokenCodec: { issue: () => 'unused-link-media-token' } as never,
    publicOrigin: 'https://relay.example',
    workerId: 'facebook-reconciler',
    leaseMs: 30_000,
  };
}

async function installCredential(keys: MasterKeyProvider): Promise<void> {
  const encrypted = await encryptCredential(Buffer.from('{"accessToken":"page-token"}'), keys);
  await (db as unknown as PgliteDatabase)
    .update(credentials)
    .set(encrypted)
    .where(eq(credentials.id, '00000000-0000-4000-8000-000000000704'));
  await database.exec(`UPDATE provider_accounts
    SET credential_id = '00000000-0000-4000-8000-000000000704'
    WHERE id = '00000000-0000-4000-8000-000000000706'`);
}

beforeEach(async () => {
  database = new PGlite();
  for (const migration of migrations)
    await database.exec(
      await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'),
    );
  await database.exec(`
    INSERT INTO workspaces (id, name, slug) VALUES
      ('${workspaceA}', 'Meta A', 'meta-a'),
      ('${workspaceB}', 'Meta B', 'meta-b');
    INSERT INTO users (id, email, password_hash) VALUES
      ('${userId}', 'meta@example.test', 'redacted');
    SELECT set_config('app.workspace_id', '${workspaceA}', false);
    INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
      wrapped_key_tag, ciphertext, nonce, tag) VALUES
      ('00000000-0000-4000-8000-000000000704', '${workspaceA}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
    INSERT INTO provider_connections (id, workspace_id, provider, credential_id) VALUES
      ('00000000-0000-4000-8000-000000000705', '${workspaceA}', 'meta', '00000000-0000-4000-8000-000000000704');
    INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id,
      display_name, destination_provider, remote_account_id) VALUES
      ('00000000-0000-4000-8000-000000000706', '${workspaceA}', '00000000-0000-4000-8000-000000000705', 'page-a', 'Page A', 'facebook_page', 'page-a'),
      ('00000000-0000-4000-8000-000000000707', '${workspaceA}', '00000000-0000-4000-8000-000000000705', 'ig-a', 'Instagram A', 'instagram', 'ig-a');
    INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES
      ('00000000-0000-4000-8000-000000000708', '${workspaceA}', '${userId}');
    INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content) VALUES
      ('00000000-0000-4000-8000-000000000711', '${workspaceA}', '00000000-0000-4000-8000-000000000708', 1, '{"type":"text","text":"Shared"}');
    INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at) VALUES
      ('${facebookJobId}', '${workspaceA}', '00000000-0000-4000-8000-000000000708', '00000000-0000-4000-8000-000000000711', '00000000-0000-4000-8000-000000000706', now()),
      ('${instagramJobId}', '${workspaceA}', '00000000-0000-4000-8000-000000000708', '00000000-0000-4000-8000-000000000711', '00000000-0000-4000-8000-000000000707', now());
  `);
  db = drizzle(database) as unknown as NodePgDatabase;
});

afterEach(async () => database.close());

describe('Facebook staging persistence', () => {
  it('persists request boundaries across store reconstruction without exposing sibling jobs', async () => {
    const first = new PostgresFacebookArtifactStore(db, {
      workspaceId: workspaceA,
      jobId: facebookJobId,
    });
    await first.ensure({ key: 'facebook_page:job:create' });
    await first.update('facebook_page:job:create', { phase: 'request_started' });

    const restarted = new PostgresFacebookArtifactStore(db, {
      workspaceId: workspaceA,
      jobId: facebookJobId,
    });
    await expect(restarted.ensure({ key: 'facebook_page:job:create' })).resolves.toMatchObject({
      phase: 'request_started',
    });
    await expect(
      restarted.update('facebook_page:job:create', {
        phase: 'provider_result',
        externalObjectId: 'page_post_1',
      }),
    ).resolves.toMatchObject({
      phase: 'provider_result',
      externalObjectId: 'page_post_1',
    });

    const rows = await database.query<{ job_id: string; redacted_evidence: unknown }>(
      `SELECT job_id, redacted_evidence FROM provider_staging_artifacts
       WHERE artifact_key = 'facebook_page:job:create'`,
    );
    expect(rows.rows).toEqual([{ job_id: facebookJobId, redacted_evidence: {} }]);
  });

  it('allows one Facebook claim while leaving the Instagram sibling independent', async () => {
    const now = new Date();
    const [first, second] = await Promise.all([
      claimDueJobs(db, {
        workerId: 'facebook-a',
        now,
        leaseMs: 30_000,
        limit: 1,
        destinationProvider: 'facebook_page',
      }),
      claimDueJobs(db, {
        workerId: 'facebook-b',
        now,
        leaseMs: 30_000,
        limit: 1,
        destinationProvider: 'facebook_page',
      }),
    ]);
    expect([...first, ...second]).toHaveLength(1);
    const owner = first.length === 1 ? 'facebook-a' : 'facebook-b';
    const loser = owner === 'facebook-a' ? 'facebook-b' : 'facebook-a';
    await expect(
      startDispatchAttempt(db, {
        workspaceId: workspaceA,
        jobId: facebookJobId,
        workerId: loser,
        fingerprint: 'facebook-claim',
        now,
      }),
    ).resolves.toBeNull();
    await expect(
      startDispatchAttempt(db, {
        workspaceId: workspaceA,
        jobId: facebookJobId,
        workerId: owner,
        fingerprint: 'facebook-claim',
        now,
      }),
    ).resolves.toMatchObject({ attemptNumber: 1 });
    const states = await database.query<{ id: string; state: string }>(
      `SELECT id, state FROM publication_jobs ORDER BY id`,
    );
    expect(states.rows).toContainEqual({ id: facebookJobId, state: 'dispatching' });
    expect(states.rows).toContainEqual({ id: instagramJobId, state: 'scheduled' });
  });

  it('resolves a durable provider result after a crash without replaying the create request', async () => {
    const keys = new TestKeys();
    await installCredential(keys);
    await database.exec(`UPDATE publication_jobs
      SET effective_payload = '{"kind":"link","message":"Shared","linkUrl":"https://example.com/story"}',
          scheduled_at = '2026-09-17T17:00:00Z'
      WHERE id = '${facebookJobId}'`);
    const startedAt = new Date('2026-09-17T18:00:00Z');
    const [job] = await claimDueJobs(db, {
      workerId: 'crashed-facebook-worker',
      now: startedAt,
      leaseMs: 30_000,
      limit: 1,
      destinationProvider: 'facebook_page',
    });
    if (!job) throw new Error('Expected Facebook job claim');
    const attempt = await startDispatchAttempt(db, {
      workspaceId: workspaceA,
      jobId: facebookJobId,
      workerId: 'crashed-facebook-worker',
      fingerprint: 'facebook-crash-window',
      now: startedAt,
    });
    if (!attempt) throw new Error('Expected Facebook dispatch attempt');

    let createRequests = 0;
    const request = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'POST') {
        createRequests += 1;
        return Promise.resolve(
          new Response('{"id":"page_post_1"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response('{"permalink_url":"https://www.facebook.com/page_post_1"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const runtime = facebookRuntime(keys, request);
    const adapter = new FacebookPublishingAdapter({
      client: runtime.client,
      artifacts: new PostgresFacebookArtifactStore(db, {
        workspaceId: workspaceA,
        jobId: facebookJobId,
      }),
      accessToken: () => Promise.resolve('page-token'),
      mediaUrl: () => Promise.reject(new Error('Link post does not use media')),
    });
    const fingerprint = deriveJobIdempotencyKey({
      jobId: facebookJobId,
      revisionId: job.revisionId,
      providerAccountId: job.providerAccountId,
    });
    await expect(
      adapter.publish(
        await adapter.stage(
          'page-a',
          {
            kind: 'link',
            text: 'Shared',
            url: 'https://example.com/story',
            media: [],
          },
          fingerprint,
        ),
      ),
    ).resolves.toMatchObject({ status: 'published', externalPostId: 'page_post_1' });

    const restartedAt = new Date(startedAt.getTime() + 30_001);
    await expect(reconcileFacebookJobs(runtime, restartedAt)).resolves.toBe(1);
    const rows = await database.query<{
      state: string;
      reconciliation_required: boolean;
      attempts: number;
      external_post_id: string | null;
      attempt_outcome: string | null;
      finished_at: Date | null;
    }>(`SELECT job.state, job.reconciliation_required,
        (SELECT count(*)::int FROM publication_attempts WHERE job_id = job.id) AS attempts,
        attempt.external_post_id, attempt.outcome AS attempt_outcome, attempt.finished_at
      FROM publication_jobs AS job
      JOIN publication_attempts AS attempt ON attempt.job_id = job.id
      WHERE job.id = '${facebookJobId}'`);
    expect(rows.rows[0]).toMatchObject({
      state: 'published',
      reconciliation_required: false,
      attempts: 1,
      external_post_id: 'page_post_1',
      attempt_outcome: 'published',
    });
    expect(rows.rows[0]?.finished_at).not.toBeNull();
    expect(createRequests).toBe(1);
  });

  it('keeps request-started work unresolved and never replays its create request', async () => {
    const keys = new TestKeys();
    await installCredential(keys);
    await database.exec(`UPDATE publication_jobs
      SET effective_payload = '{"kind":"link","message":"Shared","linkUrl":"https://example.com/story"}',
          scheduled_at = '2026-09-17T17:00:00Z'
      WHERE id = '${facebookJobId}'`);
    const startedAt = new Date('2026-09-17T18:00:00Z');
    const [job] = await claimDueJobs(db, {
      workerId: 'crashed-facebook-worker',
      now: startedAt,
      leaseMs: 30_000,
      limit: 1,
      destinationProvider: 'facebook_page',
    });
    if (!job) throw new Error('Expected Facebook job claim');
    const attempt = await startDispatchAttempt(db, {
      workspaceId: workspaceA,
      jobId: facebookJobId,
      workerId: 'crashed-facebook-worker',
      fingerprint: 'facebook-request-started',
      now: startedAt,
    });
    if (!attempt) throw new Error('Expected Facebook dispatch attempt');
    const artifacts = new PostgresFacebookArtifactStore(db, {
      workspaceId: workspaceA,
      jobId: facebookJobId,
    });
    const fingerprint = deriveJobIdempotencyKey({
      jobId: facebookJobId,
      revisionId: job.revisionId,
      providerAccountId: job.providerAccountId,
    });
    const artifactKey = `facebook_page:${fingerprint}:create`;
    await artifacts.ensure({ key: artifactKey });
    await artifacts.update(artifactKey, { phase: 'request_started' });

    let createRequests = 0;
    const request: typeof fetch = (...input): Promise<Response> => {
      void input;
      createRequests += 1;
      return Promise.resolve(new Response('{"id":"unexpected"}', { status: 200 }));
    };
    const runtime = facebookRuntime(keys, request);
    const restartedAt = new Date(startedAt.getTime() + 30_001);
    await expect(reconcileFacebookJobs(runtime, restartedAt)).resolves.toBe(0);
    const rows = await database.query<{
      state: string;
      reconciliation_required: boolean;
      external_post_id: string | null;
    }>(`SELECT job.state, job.reconciliation_required, attempt.external_post_id
      FROM publication_jobs AS job
      JOIN publication_attempts AS attempt ON attempt.job_id = job.id
      WHERE job.id = '${facebookJobId}'`);
    expect(rows.rows[0]).toEqual({
      state: 'dispatching',
      reconciliation_required: true,
      external_post_id: null,
    });
    expect(createRequests).toBe(0);
  });
});
