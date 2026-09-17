import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PostgresFacebookArtifactStore } from '../src/modules/providers/facebook-artifact-store.js';
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

const workspaceA = '00000000-0000-4000-8000-000000000701';
const workspaceB = '00000000-0000-4000-8000-000000000702';
const userId = '00000000-0000-4000-8000-000000000703';
const facebookJobId = '00000000-0000-4000-8000-000000000709';
const instagramJobId = '00000000-0000-4000-8000-000000000710';
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
});
