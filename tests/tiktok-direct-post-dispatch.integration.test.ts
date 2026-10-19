import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { encryptCredential, type MasterKeyProvider } from '../src/modules/credentials/envelope.js';
import {
  claimExactDueJob,
  recoverExpiredDispatches,
  startDispatchAttempt,
} from '../src/modules/scheduler/job.repository.js';
import { issueTikTokPublicationConsent } from '../src/modules/providers/tiktok-consent.service.js';
import {
  dispatchClaimedTikTokJob,
  dispatchDueTikTokJobs,
} from '../src/modules/providers/tiktok-direct-post-dispatch.service.js';
import { TikTokHttpClient } from '../src/modules/providers/tiktok-http-client.js';
import { TikTokMediaGrantService } from '../src/modules/providers/tiktok-media-grant.service.js';
import { scheduleTikTokDraft } from '../src/modules/providers/tiktok-schedule.service.js';

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
  '0017_dark_whizzer',
  '0019_media_retention_lifecycle',
  '0022_truthful_post_actors',
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
  '0055_x_long_post_declaration',
  '0059_provider_account_exposures',
  '0077_publication_attempt_external_url',
  '0078_tiktok_one_shot_init',
];
const workspaceId = '00000000-0000-4000-8000-000000000101';
const userId = '00000000-0000-4000-8000-000000000102';
const postId = '00000000-0000-4000-8000-000000000301';
const revisionId = '00000000-0000-4000-8000-000000000302';
const mediaId = '00000000-0000-4000-8000-000000000401';
const accountId = '00000000-0000-4000-8000-000000000501';
const connectionId = '00000000-0000-4000-8000-000000000601';
const credentialId = '00000000-0000-4000-8000-000000000701';
const snapshotId = '00000000-0000-4000-8000-000000000801';
const mediaHash = 'a'.repeat(64);
const keys: MasterKeyProvider = {
  currentVersion: () => 'fixture',
  getKey: () => Promise.resolve(Buffer.alloc(32, 7)),
};
const options = {
  privacyLevel: 'SELF_ONLY' as const,
  allowComment: false,
  allowDuet: false,
  allowStitch: false,
  commercialContent: 'none' as const,
  aiGenerated: false,
};

let pg: PGlite;
let db: NodePgDatabase;
let jobId: string;

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: { code: 'ok' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function creatorResponse(): Response {
  return response({
    creator_username: 'one',
    creator_nickname: 'One',
    creator_avatar_url: 'https://example.test/avatar',
    privacy_level_options: ['SELF_ONLY'],
    comment_disabled: false,
    duet_disabled: true,
    stitch_disabled: true,
    max_video_post_duration_sec: 120,
  });
}

function client(fetcher: typeof fetch) {
  return new TikTokHttpClient({ clientKey: 'fixture', clientSecret: 'fixture', fetch: fetcher });
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function runtime(fetcher: typeof fetch, verifiedMediaOrigin = 'https://media.example.test') {
  return {
    database: db,
    keys,
    client: client(fetcher),
    grants: new TikTokMediaGrantService(db, Buffer.alloc(32, 8)),
    workerId: 'fixture-worker',
    leaseMs: 60_000,
    publicOrigin: 'https://media.example.test',
    verifiedMediaOrigin,
  };
}

async function claim(now = new Date()) {
  return claimExactDueJob(db, {
    jobId,
    workspaceId,
    workerId: 'fixture-worker',
    now,
    leaseMs: 60_000,
  });
}

async function claimReady() {
  const job = await claim();
  if (!job) throw new Error('Fixture job was not claimable');
  return job;
}

beforeEach(async () => {
  pg = new PGlite();
  for (const name of migrations)
    await pg.exec(await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8'));
  db = drizzle(pg) as unknown as NodePgDatabase;
  const token = {
    access_token: 'fixture-access',
    refresh_token: 'fixture-refresh',
    open_id: 'subject-one',
    scope: 'video.publish',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_expires_in: 86400,
  };
  const encrypted = await encryptCredential(Buffer.from(JSON.stringify(token)), keys);
  await pg.exec(`
    insert into workspaces (id, name, slug) values ('${workspaceId}', 'One', 'one');
    insert into users (id, email, password_hash) values ('${userId}', 'owner@example.test', 'redacted');
    insert into memberships (workspace_id, user_id, role) values ('${workspaceId}', '${userId}', 'owner');
  `);
  await pg.query(
    `insert into credentials (id, workspace_id, key_version, wrapped_key,
    wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      credentialId,
      workspaceId,
      encrypted.keyVersion,
      encrypted.wrappedKey,
      encrypted.wrappedKeyNonce,
      encrypted.wrappedKeyTag,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.tag,
    ],
  );
  await pg.exec(`
    insert into provider_connections (id, workspace_id, provider, external_subject_id,
      credential_id, scopes, access_expires_at, refresh_expires_at)
      values ('${connectionId}', '${workspaceId}', 'tiktok', 'subject-one',
      '${credentialId}', '["video.publish"]', now() + interval '1 hour', now() + interval '1 day');
    insert into provider_accounts (id, workspace_id, connection_id, provider_account_id,
      destination_provider, remote_account_id, display_name)
      values ('${accountId}', '${workspaceId}', '${connectionId}', 'subject-one',
      'tiktok', 'subject-one', 'One');
    insert into media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size,
      duration_ms, width, height, video_codec, container, state, retained_at)
      values ('${mediaId}', '${workspaceId}', 'fixture.mp4', '${mediaHash}',
      'video/mp4', 1024, 30000, 1080, 1920, 'h264', 'mp4', 'ready', now());
    insert into posts (id, workspace_id, created_by_user_id)
      values ('${postId}', '${workspaceId}', '${userId}');
    insert into post_revisions (id, workspace_id, post_id, revision_number, content)
      values ('${revisionId}', '${workspaceId}', '${postId}', 1,
      '${JSON.stringify({ schemaVersion: 1, kind: 'video', caption: 'Exact caption', mediaId, options })}');
    insert into revision_media (workspace_id, revision_id, media_id, position)
      values ('${workspaceId}', '${revisionId}', '${mediaId}', 0);
    insert into provider_capability_snapshots (id, workspace_id, account_id, connection_id,
      external_subject_id, credential_version, nickname, privacy_options,
      comment_disabled, duet_disabled, stitch_disabled, max_video_duration_seconds,
      fetched_at, expires_at)
      values ('${snapshotId}', '${workspaceId}', '${accountId}', '${connectionId}',
      'subject-one', 1, 'One', '["SELF_ONLY"]', false, true, true, 120,
      now() - interval '1 minute', now() + interval '14 minutes');
  `);
  const receipt = await issueTikTokPublicationConsent(db, {
    workspaceId,
    userId,
    actor: { type: 'user', id: userId },
    postId,
    revisionId,
    accountId,
    capabilitySnapshotId: snapshotId,
    options,
    musicUsageConfirmed: true,
    brandedContentPolicyConfirmed: false,
  });
  const scheduled = await scheduleTikTokDraft(db, {
    workspaceId,
    userId,
    postId,
    revisionId,
    accountId,
    receiptId: receipt.id,
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    requestId: 'fixture-schedule',
    idempotencyKey: 'fixture-schedule',
  });
  jobId = scheduled.jobId;
  await pg.query(
    "update publication_jobs set scheduled_at = now() - interval '1 second' where id = $1",
    [jobId],
  );
});

afterEach(async () => pg.close());

it('persists init_sending before one HTTP init, then accepted_pending without a second claim', async () => {
  const calls = vi.fn<typeof fetch>(async (url) => {
    if (requestUrl(url).endsWith('/creator_info/query/')) return creatorResponse();
    const reserved = await pg.query<{ tiktok_init_phase: string; tiktok_media_grant_id: string }>(
      'select tiktok_init_phase, tiktok_media_grant_id from publication_attempts where job_id = $1',
      [jobId],
    );
    expect(reserved.rows[0]).toMatchObject({ tiktok_init_phase: 'init_sending' });
    expect(reserved.rows[0]?.tiktok_media_grant_id).toBeTruthy();
    return response({ publish_id: 'publish-fixture' });
  });
  expect(await dispatchDueTikTokJobs(runtime(calls))).toBe(1);
  const attempt = await pg.query<{ tiktok_init_phase: string; provider_request_id: string }>(
    'select tiktok_init_phase, provider_request_id from publication_attempts where job_id = $1',
    [jobId],
  );
  expect(attempt.rows[0]).toEqual({
    tiktok_init_phase: 'accepted_pending',
    provider_request_id: 'publish-fixture',
  });
  expect(await claim(new Date(Date.now() + 120_000))).toBeNull();
  expect(calls).toHaveBeenCalledTimes(2);
});

it('treats lost init response as unknown and never re-inits after lease recovery', async () => {
  const calls = vi.fn<typeof fetch>((url) => {
    if (requestUrl(url).endsWith('/creator_info/query/')) return Promise.resolve(creatorResponse());
    return Promise.reject(new Error('connection lost'));
  });
  const claimed = await claimReady();
  expect(await dispatchClaimedTikTokJob(runtime(calls), claimed)).toBe('outcome_unknown');
  expect(await claim(new Date(Date.now() + 120_000))).toBeNull();
  expect(calls).toHaveBeenCalledTimes(2);
  const attempt = await pg.query<{ tiktok_init_phase: string; outcome: string }>(
    'select tiktok_init_phase, outcome from publication_attempts where job_id = $1',
    [jobId],
  );
  expect(attempt.rows[0]).toEqual({ tiktok_init_phase: 'outcome_unknown', outcome: 'unknown' });
  await expect(recoverExpiredDispatches(db, new Date(Date.now() + 120_000))).resolves.toEqual([]);
});

it('refuses an unverified media property before provider calls or attempt reservation', async () => {
  const calls = vi.fn<typeof fetch>();
  const claimed = await claimReady();
  await expect(
    dispatchClaimedTikTokJob(runtime(calls, 'https://different.example.test'), claimed),
  ).rejects.toThrow('verified media property');
  expect(calls).not.toHaveBeenCalled();
  expect((await pg.query('select id from publication_attempts')).rows).toHaveLength(0);
});

it('refreshes creator facts for an expired consent-time snapshot', async () => {
  await pg.query(
    "update provider_capability_snapshots set expires_at = now() - interval '1 second' where id = $1",
    [snapshotId],
  );
  const calls = vi.fn<typeof fetch>((url) =>
    Promise.resolve(
      requestUrl(url).endsWith('/creator_info/query/')
        ? creatorResponse()
        : response({ publish_id: 'publish-after-snapshot-expiry' }),
    ),
  );
  expect(await dispatchClaimedTikTokJob(runtime(calls), await claimReady())).toBe(
    'accepted_pending',
  );
  expect(calls).toHaveBeenCalledTimes(2);
});

it('refuses changed retained media before Direct Post init', async () => {
  await pg.query('update media_objects set sha256 = $1 where id = $2', ['b'.repeat(64), mediaId]);
  const calls = vi.fn<typeof fetch>(() => Promise.resolve(creatorResponse()));
  await expect(dispatchClaimedTikTokJob(runtime(calls), await claimReady())).rejects.toThrow(
    'invalid',
  );
  expect(calls).toHaveBeenCalledTimes(1);
  expect((await pg.query('select id from publication_attempts')).rows).toHaveLength(0);
});

it('recovers a crash after durable init_sending as reconciliation, never a second claim', async () => {
  const claimed = await claim();
  expect(claimed).not.toBeNull();
  const grant = await new TikTokMediaGrantService(db, Buffer.alloc(32, 8)).issue({
    workspaceId,
    accountId,
    mediaId,
    publicOrigin: 'https://media.example.test',
  });
  const attempt = await startDispatchAttempt(db, {
    workspaceId,
    jobId,
    workerId: 'fixture-worker',
    fingerprint: 'fixture-request-fingerprint',
    tiktokMediaGrantId: grant.id,
    now: new Date(),
  });
  expect(attempt?.attemptId).toBeTruthy();
  expect(await recoverExpiredDispatches(db, new Date(Date.now() + 120_000))).toEqual([jobId]);
  const rows = await pg.query<{ state: string; reconciliation_required: boolean }>(
    'select state, reconciliation_required from publication_jobs where id = $1',
    [jobId],
  );
  expect(rows.rows[0]).toEqual({ state: 'dispatching', reconciliation_required: true });
  expect(await claim(new Date(Date.now() + 120_000))).toBeNull();
  expect(
    (await pg.query('select id from publication_attempts where job_id = $1', [jobId])).rows,
  ).toHaveLength(1);
});
