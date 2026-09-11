import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionPolicy } from '../src/modules/policy/action-policy.js';
import { getBrowserJobDetail } from '../src/modules/content/post-read.repository.js';

import {
  claimDueJobs,
  claimExactDueJob,
  claimReconciliationJobs,
  cancelPendingJob,
  finishDispatchAttempt,
  extendOwnedLease,
  recoverExpiredDispatches,
  requestOperatorRetry,
  resolveReconciliation,
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
  '0037_brown_wallflower.sql',
];
const workspaceId = '00000000-0000-4000-8000-000000000301';
const jobId = '00000000-0000-4000-8000-000000000307';
let database: PGlite;
let db: NodePgDatabase;

beforeEach(async () => {
  database = new PGlite();
  for (const migration of migrations)
    await database.exec(
      await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'),
    );
  await database.exec(`
    INSERT INTO workspaces (id, name, slug) VALUES ('${workspaceId}', 'Scheduler', 'scheduler');
    INSERT INTO users (id, email, password_hash, display_name) VALUES ('00000000-0000-4000-8000-000000000302', 'scheduler@example.test', 'redacted', 'Scheduler');
    SELECT set_config('app.workspace_id', '${workspaceId}', false);
    INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
      VALUES ('00000000-0000-4000-8000-000000000303', '${workspaceId}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
    INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
      VALUES ('00000000-0000-4000-8000-000000000304', '${workspaceId}', 'fake', '00000000-0000-4000-8000-000000000303');
    INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, display_name)
      VALUES ('00000000-0000-4000-8000-000000000305', '${workspaceId}', '00000000-0000-4000-8000-000000000304', 'scheduler', 'Scheduler');
    INSERT INTO posts (id, workspace_id, created_by_user_id)
      VALUES ('00000000-0000-4000-8000-000000000306', '${workspaceId}', '00000000-0000-4000-8000-000000000302');
    INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
      VALUES ('00000000-0000-4000-8000-000000000308', '${workspaceId}', '00000000-0000-4000-8000-000000000306', 1, '{"type":"text","text":"Due"}');
    INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at)
      VALUES ('${jobId}', '${workspaceId}', '00000000-0000-4000-8000-000000000306', '00000000-0000-4000-8000-000000000308', '00000000-0000-4000-8000-000000000305', '2026-08-31T15:00:00Z');
  `);
  db = drizzle(database) as unknown as NodePgDatabase;
});

afterEach(async () => database.close());

describe('scheduler repository', () => {
  it('atomically claims a due job only once until its lease expires', async () => {
    const now = new Date('2026-08-31T15:30:00Z');
    const [first, second] = await Promise.all([
      claimDueJobs(db, { workerId: 'worker-a', now, leaseMs: 30_000, limit: 1 }),
      claimDueJobs(db, { workerId: 'worker-b', now, leaseMs: 30_000, limit: 1 }),
    ]);
    expect([...first, ...second]).toHaveLength(1);
    expect([...first, ...second][0]).toMatchObject({
      id: jobId,
      state: 'leased',
      attemptNumber: 1,
    });
    expect(
      await extendOwnedLease(db, {
        workspaceId,
        jobId,
        workerId: 'wrong-worker',
        now,
        leaseMs: 60_000,
      }),
    ).toBe(false);
    const owner = first.length === 1 ? 'worker-a' : 'worker-b';
    expect(
      await extendOwnedLease(db, { workspaceId, jobId, workerId: owner, now, leaseMs: 60_000 }),
    ).toBe(true);
  });

  it('marks posts over 30 minutes late for review without dispatching or changing their schedule', async () => {
    const now = new Date('2026-08-31T15:30:00.001Z');
    await database.exec(`
      INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at)
      VALUES
        ('00000000-0000-4000-8000-000000000321', '${workspaceId}', '00000000-0000-4000-8000-000000000306', '00000000-0000-4000-8000-000000000308', '00000000-0000-4000-8000-000000000305', '2026-08-31T14:56:00Z'),
        ('00000000-0000-4000-8000-000000000322', '${workspaceId}', '00000000-0000-4000-8000-000000000306', '00000000-0000-4000-8000-000000000308', '00000000-0000-4000-8000-000000000305', '2026-08-31T14:57:00Z'),
        ('00000000-0000-4000-8000-000000000323', '${workspaceId}', '00000000-0000-4000-8000-000000000306', '00000000-0000-4000-8000-000000000308', '00000000-0000-4000-8000-000000000305', '2026-08-31T14:58:00Z'),
        ('00000000-0000-4000-8000-000000000324', '${workspaceId}', '00000000-0000-4000-8000-000000000306', '00000000-0000-4000-8000-000000000308', '00000000-0000-4000-8000-000000000305', '2026-08-31T14:59:00Z');
    `);

    expect(
      await claimDueJobs(db, { workerId: 'worker-a', now, leaseMs: 30_000, limit: 10 }),
    ).toEqual([]);

    const result = await database.query<{
      state: string;
      scheduled_at: Date;
      attempt_number: number;
      reason: string;
    }>(`
      SELECT job.state, job.scheduled_at, job.attempt_number, event.reason
      FROM publication_jobs job
      JOIN publication_job_events event ON event.job_id = job.id
      WHERE job.id = '${jobId}'
    `);
    expect(result.rows).toEqual([
      {
        state: 'needs_review',
        scheduled_at: new Date('2026-08-31T15:00:00Z'),
        attempt_number: 0,
        reason: 'missed_schedule_grace',
      },
    ]);
    const backlog = await database.query<{ state: string; count: string }>(`
      SELECT state, count(*)::text AS count FROM publication_jobs GROUP BY state
    `);
    expect(backlog.rows).toEqual([{ state: 'needs_review', count: '5' }]);
  });

  it('marks an exact overdue job for review without claiming it', async () => {
    const scheduledAt = new Date('2026-08-31T15:00:00Z');
    const claimed = await claimExactDueJob(db, {
      jobId,
      workspaceId,
      workerId: 'exact-worker',
      now: new Date('2026-08-31T15:30:00.001Z'),
      leaseMs: 30_000,
    });

    expect(claimed).toBeNull();
    const result = await database.query<{
      state: string;
      scheduled_at: Date;
      attempt_number: number;
      reason: string;
    }>(`
      SELECT job.state, job.scheduled_at, job.attempt_number, event.reason
      FROM publication_jobs job
      JOIN publication_job_events event ON event.job_id = job.id
      WHERE job.id = '${jobId}'
    `);
    expect(result.rows).toEqual([
      {
        state: 'needs_review',
        scheduled_at: scheduledAt,
        attempt_number: 0,
        reason: 'missed_schedule_grace',
      },
    ]);
  });

  it('marks an expired dispatch for reconciliation instead of reclaiming it', async () => {
    await database.exec(`UPDATE publication_jobs SET state = 'dispatching', lease_owner = 'dead',
      lease_expires_at = '2026-08-31T15:00:00Z' WHERE id = '${jobId}'`);
    expect(await recoverExpiredDispatches(db, new Date('2026-08-31T16:00:00Z'))).toEqual([jobId]);
    expect(
      await claimDueJobs(db, {
        workerId: 'worker-a',
        now: new Date('2026-08-31T16:00:00Z'),
        leaseMs: 30_000,
        limit: 1,
      }),
    ).toEqual([]);
    const result = await database.query<{ reconciliation_required: boolean }>(
      `SELECT reconciliation_required FROM publication_jobs WHERE id = '${jobId}'`,
    );
    expect(result.rows[0]?.reconciliation_required).toBe(true);
  });

  it('starts one owned dispatch attempt and keeps the provider idempotency key stable', async () => {
    const now = new Date('2026-08-31T15:30:00Z');
    await claimDueJobs(db, { workerId: 'worker-a', now, leaseMs: 30_000, limit: 1 });
    const first = await startDispatchAttempt(db, {
      workspaceId,
      jobId,
      workerId: 'worker-a',
      fingerprint: 'fingerprint-one',
      now,
    });
    expect(first).toMatchObject({ attemptNumber: 1 });
    expect(
      await startDispatchAttempt(db, {
        workspaceId,
        jobId,
        workerId: 'worker-b',
        fingerprint: 'fingerprint-stolen',
        now,
      }),
    ).toBeNull();

    await database.exec(`UPDATE publication_jobs SET state = 'retry_wait', next_attempt_at = '${now.toISOString()}',
      lease_owner = null, lease_expires_at = null WHERE id = '${jobId}'`);
    await claimDueJobs(db, { workerId: 'worker-b', now, leaseMs: 30_000, limit: 1 });
    const second = await startDispatchAttempt(db, {
      workspaceId,
      jobId,
      workerId: 'worker-b',
      fingerprint: 'fingerprint-two',
      now,
    });
    expect(second).toMatchObject({ attemptNumber: 2, idempotencyKey: first?.idempotencyKey });
  });

  it('records retry outcomes once and audits an idempotent operator retry boundary', async () => {
    const now = new Date('2026-08-31T15:30:00Z');
    await claimDueJobs(db, { workerId: 'worker-a', now, leaseMs: 30_000, limit: 1 });
    const attempt = await startDispatchAttempt(db, {
      workspaceId,
      jobId,
      workerId: 'worker-a',
      fingerprint: 'fingerprint',
      now,
    });
    if (!attempt) throw new Error('Expected dispatch attempt');
    const retryAt = new Date('2026-08-31T16:01:00Z');
    expect(
      await finishDispatchAttempt(db, {
        workspaceId,
        jobId,
        attemptId: attempt.attemptId,
        outcome: 'transient',
        retryAt,
        redactedError: 'temporary provider failure',
        now,
      }),
    ).toBe(true);
    expect(
      await finishDispatchAttempt(db, {
        workspaceId,
        jobId,
        attemptId: attempt.attemptId,
        outcome: 'transient',
        retryAt,
        now,
      }),
    ).toBe(false);
    await database.exec(
      `UPDATE publication_jobs SET state = 'failed', next_attempt_at = null WHERE id = '${jobId}'`,
    );
    expect(await requestOperatorRetry(db, { workspaceId, jobId, actorId: 'operator', now })).toBe(
      'scheduled',
    );
    expect(await requestOperatorRetry(db, { workspaceId, jobId, actorId: 'operator', now })).toBe(
      'conflict',
    );
    const result = await database.query<{ reason: string }>(
      `SELECT reason FROM publication_job_events WHERE job_id = '${jobId}' ORDER BY created_at`,
    );
    expect(result.rows.map((row) => row.reason)).toEqual([
      'worker_claim',
      'worker_dispatch',
      'attempt_transient',
      'operator_retry',
    ]);
  });

  it('denies operator retry exactly once without changing job or event state', async () => {
    const now = new Date('2026-08-31T15:30:00Z');
    await database.exec(
      `UPDATE publication_jobs SET state = 'failed', next_attempt_at = null WHERE id = '${jobId}'`,
    );
    let evaluations = 0;
    const policy: ActionPolicy = {
      evaluate(context) {
        evaluations += 1;
        expect(context.action).toBe('publication.retry');
        return Promise.resolve({ allowed: false, code: 'action_not_allowed', reason: 'Denied' });
      },
    };
    await expect(
      requestOperatorRetry(db, { workspaceId, jobId, actorId: 'operator', now }, policy),
    ).rejects.toMatchObject({ code: 'action_not_allowed' });
    expect(evaluations).toBe(1);
    const rows = await database.query<{ state: string; event_count: number }>(`select
      job.state,
      (select count(*)::int from publication_job_events event
       where event.job_id = job.id and event.reason = 'operator_retry') event_count
      from publication_jobs job where job.id = '${jobId}'`);
    expect(rows.rows[0]).toEqual({ state: 'failed', event_count: 0 });
  });

  it('allows cancellation only before the dispatch boundary', async () => {
    const input = {
      workspaceId,
      jobId,
      actorId: 'operator',
      now: new Date('2026-08-31T16:00:00Z'),
    };
    expect(await cancelPendingJob(db, input)).toBe(true);
    expect(await cancelPendingJob(db, input)).toBe(false);
  });

  it('reconciles an unknown outcome without creating a blind publish attempt', async () => {
    const now = new Date('2026-08-31T15:30:00Z');
    await claimDueJobs(db, { workerId: 'publisher', now, leaseMs: 30_000, limit: 1 });
    const attempt = await startDispatchAttempt(db, {
      workspaceId,
      jobId,
      workerId: 'publisher',
      fingerprint: 'unknown-request',
      now,
    });
    if (!attempt) throw new Error('Expected dispatch attempt');
    await finishDispatchAttempt(db, {
      workspaceId,
      jobId,
      attemptId: attempt.attemptId,
      outcome: 'unknown',
      reconciliationKey: 'provider-lookup-key',
      now,
    });
    expect(
      await claimDueJobs(db, {
        workerId: 'publisher',
        now: new Date(now.getTime() + 60_000),
        leaseMs: 30_000,
        limit: 1,
      }),
    ).toEqual([]);
    expect(
      await claimReconciliationJobs(db, {
        workerId: 'reconciler',
        now,
        leaseMs: 30_000,
        limit: 1,
      }),
    ).toEqual([jobId]);
    expect(
      await resolveReconciliation(db, {
        workspaceId,
        jobId,
        workerId: 'reconciler',
        outcome: 'published',
        externalPostId: 'youtube-video-1',
        now,
      }),
    ).toBe(true);
    expect(
      await resolveReconciliation(db, {
        workspaceId,
        jobId,
        workerId: 'reconciler',
        outcome: 'published',
        now,
      }),
    ).toBe(false);
    const result = await database.query<{
      attempts: number;
      state: string;
      external_post_id: string;
    }>(`
      SELECT (SELECT count(*)::int FROM publication_attempts WHERE job_id = '${jobId}') AS attempts,
             state,
             (SELECT external_post_id FROM publication_attempts WHERE job_id = '${jobId}' ORDER BY attempt_number DESC LIMIT 1) AS external_post_id
      FROM publication_jobs WHERE id = '${jobId}'
    `);
    expect(result.rows[0]).toEqual({
      attempts: 1,
      state: 'published',
      external_post_id: 'youtube-video-1',
    });
    await database.exec(`UPDATE provider_connections SET provider = 'youtube'
      WHERE id = '00000000-0000-4000-8000-000000000304'`);
    const detail = await getBrowserJobDetail(db, workspaceId, jobId);
    expect(detail?.providerResult).toEqual({
      id: 'youtube-video-1',
      url: 'https://www.youtube.com/watch?v=youtube-video-1',
    });
  });

  it('makes accepted-pending jobs eligible for reconciliation', async () => {
    const now = new Date('2026-08-31T15:30:00Z');
    await claimDueJobs(db, { workerId: 'publisher', now, leaseMs: 30_000, limit: 1 });
    const attempt = await startDispatchAttempt(db, {
      workspaceId,
      jobId,
      workerId: 'publisher',
      fingerprint: 'accepted-request',
      now,
    });
    if (!attempt) throw new Error('Expected dispatch attempt');
    await finishDispatchAttempt(db, {
      workspaceId,
      jobId,
      attemptId: attempt.attemptId,
      outcome: 'accepted_pending',
      reconciliationKey: 'provider-job',
      now,
    });
    expect(
      await claimReconciliationJobs(db, {
        workerId: 'reconciler',
        now,
        leaseMs: 30_000,
        limit: 1,
      }),
    ).toEqual([jobId]);
    expect(
      await resolveReconciliation(db, {
        workspaceId,
        jobId,
        workerId: 'reconciler',
        outcome: 'accepted_pending',
        now,
      }),
    ).toBe(true);
    const pending = await database.query<{ reconciliation_required: boolean; state: string }>(
      `SELECT reconciliation_required, state FROM publication_jobs WHERE id = '${jobId}'`,
    );
    expect(pending.rows[0]).toEqual({ reconciliation_required: true, state: 'accepted_pending' });
    expect(
      await claimReconciliationJobs(db, {
        workerId: 'next-reconciler',
        now,
        leaseMs: 30_000,
        limit: 1,
      }),
    ).toEqual([jobId]);
  });

  it('isolates reconciliation claims by provider while retaining the unfiltered path', async () => {
    const youtubeJobId = '00000000-0000-4000-8000-000000000317';
    const now = new Date('2026-08-31T16:00:00Z');
    await database.exec(`
      UPDATE provider_connections SET provider = 'x' WHERE id = '00000000-0000-4000-8000-000000000304';
      INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
        VALUES ('00000000-0000-4000-8000-000000000314', '${workspaceId}', 'youtube', '00000000-0000-4000-8000-000000000303');
      INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, display_name)
        VALUES ('00000000-0000-4000-8000-000000000315', '${workspaceId}', '00000000-0000-4000-8000-000000000314', 'youtube-channel', 'YouTube');
      INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at, state, reconciliation_required)
        VALUES ('${youtubeJobId}', '${workspaceId}', '00000000-0000-4000-8000-000000000306', '00000000-0000-4000-8000-000000000308', '00000000-0000-4000-8000-000000000315', '2026-08-31T15:00:00Z', 'accepted_pending', true);
      UPDATE publication_jobs SET state = 'accepted_pending', reconciliation_required = true WHERE id = '${jobId}';
    `);

    expect(
      await claimReconciliationJobs(db, {
        workerId: 'x-reconciler',
        now,
        leaseMs: 30_000,
        limit: 10,
        provider: 'x',
      }),
    ).toEqual([jobId]);
    await database.exec(`UPDATE publication_jobs SET lease_owner = NULL, lease_expires_at = NULL`);
    expect(
      await claimReconciliationJobs(db, {
        workerId: 'youtube-reconciler',
        now,
        leaseMs: 30_000,
        limit: 10,
        provider: 'youtube',
      }),
    ).toEqual([youtubeJobId]);
    await database.exec(`UPDATE publication_jobs SET lease_owner = NULL, lease_expires_at = NULL`);
    expect(
      await claimReconciliationJobs(db, {
        workerId: 'all-reconciler',
        now,
        leaseMs: 30_000,
        limit: 10,
      }),
    ).toEqual([jobId, youtubeJobId]);
  });

  it('rejects reconciliation resolution after the owned lease expires', async () => {
    const claimedAt = new Date('2026-08-31T16:00:00Z');
    await database.exec(`UPDATE publication_jobs SET state = 'accepted_pending',
      reconciliation_required = true WHERE id = '${jobId}'`);
    await claimReconciliationJobs(db, {
      workerId: 'reconciler',
      now: claimedAt,
      leaseMs: 30_000,
      limit: 1,
    });
    expect(
      await resolveReconciliation(db, {
        workspaceId,
        jobId,
        workerId: 'reconciler',
        outcome: 'published',
        now: new Date(claimedAt.getTime() + 30_001),
      }),
    ).toBe(false);
  });
});
