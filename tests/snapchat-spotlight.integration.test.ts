import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/modules/providers/snapchat-credential.service.js', () => ({
  getFreshSnapchatToken: vi.fn(() => Promise.resolve({ access_token: 'fixture' })),
}));
vi.mock('../src/modules/providers/snapchat-spotlight-upload.js', () => ({
  stageAndPostSnapchatSpotlight: vi.fn(),
}));

import { dispatchDueSnapchatSpotlights } from '../src/modules/providers/snapchat-spotlight-dispatch.service.js';
import { requestOperatorRetry } from '../src/modules/scheduler/job.repository.js';
import { stageAndPostSnapchatSpotlight } from '../src/modules/providers/snapchat-spotlight-upload.js';

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
  '0014_great_lethal_legion',
  '0015_talented_alex_power',
  '0016_common_barracuda',
  '0017_dark_whizzer',
  '0019_media_retention_lifecycle',
  '0022_truthful_post_actors',
  '0024_mp4_media_metadata',
  '0025_lucky_legion',
  '0026_parallel_human_cannonball',
  '0027_overjoyed_dark_beast',
  '0045_meta_destination_foundation',
  '0046_linkedin_connection_expiry',
  '0047_linkedin_member_connections',
  '0048_reconcile_linkedin_connections',
  '0049_meta_effective_payload',
  '0050_instagram_staging_artifacts',
  '0051_provider_subject_lifecycle',
  '0054_tiktok_media_grants',
  '0077_publication_attempt_external_url',
  '0078_tiktok_one_shot_init',
];
const workspaceId = '00000000-0000-4000-8000-000000000101';
const userId = '00000000-0000-4000-8000-000000000102';
const profileId = '00000000-0000-4000-8000-000000000103';
const accountId = '00000000-0000-4000-8000-000000000104';
const mediaId = '00000000-0000-4000-8000-000000000105';
const jobId = '00000000-0000-4000-8000-000000000106';
let pg: PGlite;
let db: NodePgDatabase;

beforeEach(async () => {
  vi.clearAllMocks();
  pg = new PGlite();
  for (const name of migrations)
    await pg.exec(await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8'));
  db = drizzle(pg) as unknown as NodePgDatabase;
  await pg.exec(`
    insert into workspaces (id, name, slug) values ('${workspaceId}', 'One', 'one');
    insert into users (id, email, password_hash) values ('${userId}', 'owner@example.test', 'redacted');
    insert into memberships (workspace_id, user_id, role) values ('${workspaceId}', '${userId}', 'owner');
    insert into credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
      wrapped_key_tag, ciphertext, nonce, tag)
      values ('00000000-0000-4000-8000-000000000110', '${workspaceId}', 'fixture',
      '\\x01', '\\x01', '\\x01', '\\x01', '\\x01', '\\x01');
    insert into provider_connections (id, workspace_id, provider, external_subject_id, credential_id)
      values ('00000000-0000-4000-8000-000000000111', '${workspaceId}', 'snapchat',
        '${profileId}', '00000000-0000-4000-8000-000000000110');
    insert into provider_accounts (id, workspace_id, connection_id, provider_account_id,
      destination_provider, remote_account_id, display_name)
      values ('${accountId}', '${workspaceId}', '00000000-0000-4000-8000-000000000111',
        '${profileId}', 'snapchat', '${profileId}', 'Owner profile');
    insert into media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size,
      duration_ms, width, height, video_codec, container, state)
      values ('${mediaId}', '${workspaceId}', 'fixture.mp4', '${'a'.repeat(64)}',
        'video/mp4', 10, 6000, 540, 960, 'h264', 'mp4', 'ready');
    insert into posts (id, workspace_id, created_by_user_id)
      values ('00000000-0000-4000-8000-000000000112', '${workspaceId}', '${userId}');
    insert into post_revisions (id, workspace_id, post_id, revision_number, content)
      values ('00000000-0000-4000-8000-000000000113', '${workspaceId}',
        '00000000-0000-4000-8000-000000000112', 1, '{}');
    insert into revision_media (workspace_id, revision_id, media_id, position)
      values ('${workspaceId}', '00000000-0000-4000-8000-000000000113', '${mediaId}', 0);
    insert into publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id,
      effective_payload, scheduled_at)
      values ('${jobId}', '${workspaceId}', '00000000-0000-4000-8000-000000000112',
        '00000000-0000-4000-8000-000000000113', '${accountId}',
        '{"schemaVersion":1,"kind":"spotlight_video","mediaId":"${mediaId}","locale":"en_US"}',
        '2026-10-19T19:00:00Z');
  `);
  await pg.exec(
    await readFile(
      new URL('../migrations/0059_provider_account_exposures.sql', import.meta.url),
      'utf8',
    ),
  );
});
afterEach(async () => pg.close());

function runtime() {
  return {
    database: db,
    keys: {} as never,
    oauthClient: {} as never,
    client: {} as never,
    mediaStorage: { openVerifiedRange: vi.fn() } as never,
    workerId: 'fixture-worker',
    leaseMs: 60_000,
  };
}

it('persists the owner-profile Spotlight as pending with an attempt and staging ID', async () => {
  vi.mocked(stageAndPostSnapchatSpotlight).mockImplementation(async (input) => {
    await input.onMediaCreated?.('remote-media');
    await input.onSpotlightPosted?.('spotlight-one');
    return { spotlightId: 'spotlight-one', mediaId: 'remote-media' };
  });
  const accepted = await dispatchDueSnapchatSpotlights(runtime(), new Date('2026-10-19T20:00:00Z'));
  expect(stageAndPostSnapchatSpotlight).toHaveBeenCalled();
  expect(accepted).toBe(1);
  expect(
    (await pg.query<{ state: string }>('select state from publication_jobs where id = $1', [jobId]))
      .rows[0]?.state,
  ).toBe('accepted_pending');
  expect(
    (
      await pg.query<{ external_post_id: string }>(
        'select external_post_id from publication_attempts where job_id = $1',
        [jobId],
      )
    ).rows[0]?.external_post_id,
  ).toBe('spotlight-one');
  expect(
    (
      await pg.query<{ external_object_id: string }>(
        'select external_object_id from provider_staging_artifacts where job_id = $1',
        [jobId],
      )
    ).rows[0]?.external_object_id,
  ).toBe('spotlight-one');
});

it('refuses a changed owner-profile binding before any provider call', async () => {
  await pg.exec(`update provider_accounts set remote_account_id = 'other-profile'
    where id = '${accountId}'`);
  expect(await dispatchDueSnapchatSpotlights(runtime(), new Date('2026-10-19T20:00:00Z'))).toBe(0);
  expect(stageAndPostSnapchatSpotlight).not.toHaveBeenCalled();
  expect(
    (await pg.query<{ state: string }>('select state from publication_jobs where id = $1', [jobId]))
      .rows[0]?.state,
  ).toBe('failed');
  expect(
    (
      await pg.query<{ reconciliation_required: boolean }>(
        'select reconciliation_required from publication_jobs where id = $1',
        [jobId],
      )
    ).rows[0]?.reconciliation_required,
  ).toBe(false);
});

it('fails a source error before POST without an unresolvable reconciliation key', async () => {
  vi.mocked(stageAndPostSnapchatSpotlight).mockRejectedValueOnce(new Error('source unavailable'));
  expect(await dispatchDueSnapchatSpotlights(runtime(), new Date('2026-10-19T20:00:00Z'))).toBe(0);
  const job = await pg.query<{ state: string; reconciliation_required: boolean }>(
    'select state, reconciliation_required from publication_jobs where id = $1',
    [jobId],
  );
  expect(job.rows[0]).toEqual({ state: 'failed', reconciliation_required: false });
  const attempt = await pg.query<{ outcome: string; reconciliation_key: string | null }>(
    'select outcome, reconciliation_key from publication_attempts where job_id = $1',
    [jobId],
  );
  expect(attempt.rows[0]).toEqual({ outcome: 'permanent', reconciliation_key: null });
});

it('can safely retry a proven pre-POST failure with a fresh per-attempt staging artifact', async () => {
  vi.mocked(stageAndPostSnapchatSpotlight)
    .mockImplementationOnce(async (input) => {
      await input.onMediaCreated?.('first-upload');
      throw new Error('source failed before Spotlight POST');
    })
    .mockImplementationOnce(async (input) => {
      await input.onMediaCreated?.('second-upload');
      await input.onBeforeSpotlightPost?.();
      await input.onSpotlightPosted?.('spotlight-retry');
      return { mediaId: 'second-upload', spotlightId: 'spotlight-retry' };
    });
  const firstTime = new Date('2026-10-19T20:00:00Z');
  expect(await dispatchDueSnapchatSpotlights(runtime(), firstTime)).toBe(0);
  expect(
    await requestOperatorRetry(db, {
      workspaceId,
      jobId,
      actorId: userId,
      now: new Date('2026-10-19T20:01:00Z'),
    }),
  ).toBe('scheduled');
  expect(await dispatchDueSnapchatSpotlights(runtime(), new Date('2026-10-19T20:02:00Z'))).toBe(1);
  const artifacts = await pg.query<{
    artifact_key: string;
    external_object_id: string | null;
    deleted_at: Date | null;
  }>(
    'select artifact_key, external_object_id, deleted_at from provider_staging_artifacts where job_id = $1 order by artifact_key',
    [jobId],
  );
  expect(
    artifacts.rows.map(({ artifact_key, external_object_id }) => ({
      artifact_key,
      external_object_id,
    })),
  ).toEqual([
    { artifact_key: 'snapchat:spotlight:1', external_object_id: null },
    { artifact_key: 'snapchat:spotlight:2', external_object_id: 'spotlight-retry' },
  ]);
  expect(artifacts.rows[0]?.deleted_at).not.toBeNull();
  expect(artifacts.rows[1]?.deleted_at).toBeNull();
  expect(stageAndPostSnapchatSpotlight).toHaveBeenCalledTimes(2);
  expect(
    (await pg.query<{ state: string }>('select state from publication_jobs where id = $1', [jobId]))
      .rows[0]?.state,
  ).toBe('accepted_pending');
});

it('keeps a possibly sent POST unknown without a blind retry', async () => {
  vi.mocked(stageAndPostSnapchatSpotlight).mockImplementationOnce(async (input) => {
    await input.onBeforeSpotlightPost?.();
    throw new Error('connection lost after POST began');
  });
  expect(await dispatchDueSnapchatSpotlights(runtime(), new Date('2026-10-19T20:00:00Z'))).toBe(0);
  const job = await pg.query<{ state: string; reconciliation_required: boolean }>(
    'select state, reconciliation_required from publication_jobs where id = $1',
    [jobId],
  );
  expect(job.rows[0]).toEqual({ state: 'dispatching', reconciliation_required: true });
  const attempt = await pg.query<{ outcome: string; reconciliation_key: string }>(
    'select outcome, reconciliation_key from publication_attempts where job_id = $1',
    [jobId],
  );
  expect(attempt.rows[0]).toEqual({ outcome: 'unknown', reconciliation_key: `snapchat:${jobId}` });
  expect(
    await requestOperatorRetry(db, {
      workspaceId,
      jobId,
      actorId: userId,
      now: new Date('2026-10-19T20:01:00Z'),
    }),
  ).toBe('conflict');
});
