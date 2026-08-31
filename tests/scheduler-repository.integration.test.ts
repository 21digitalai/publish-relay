import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimDueJobs, recoverExpiredDispatches } from '../src/modules/scheduler/job.repository.js';

const migrations = [
  '0000_identity_tenancy.sql',
  '0001_solid_spiral.sql',
  '0002_busy_mantis.sql',
  '0003_many_marvel_boy.sql',
  '0004_easy_doctor_spectrum.sql',
  '0005_round_thunderball.sql',
  '0006_enforce_content_workspace_foreign_keys.sql',
  '0007_add_scheduler_attempt_ledger.sql',
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
    INSERT INTO users (id, email, password_hash) VALUES ('00000000-0000-4000-8000-000000000302', 'scheduler@example.test', 'redacted');
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
    const now = new Date('2026-08-31T16:00:00Z');
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
});
