import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  executeIdempotentMutation,
  type IdempotentMutationInput,
} from '../src/modules/api/idempotency.repository.js';

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
  '0031_graceful_photon.sql',
];
const workspaceId = '00000000-0000-4000-8000-000000000701';
const apiKeyId = '00000000-0000-4000-8000-000000000703';
let database: PGlite;
let db: NodePgDatabase;

beforeEach(async () => {
  database = new PGlite();
  for (const migration of migrations)
    await database.exec(
      await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'),
    );
  await database.exec(`
    INSERT INTO workspaces (id, name, slug) VALUES ('${workspaceId}', 'API', 'api');
    INSERT INTO users (id, display_name, email, password_hash) VALUES ('00000000-0000-4000-8000-000000000702', 'API Owner', 'api@example.test', 'redacted');
    SELECT set_config('app.workspace_id', '${workspaceId}', false);
    INSERT INTO api_keys (id, workspace_id, created_by_user_id, label, prefix, secret_hash)
      VALUES ('${apiKeyId}', '${workspaceId}', '00000000-0000-4000-8000-000000000702', 'Agent', 'pr_test', 'redacted');
  `);
  db = drizzle(database) as unknown as NodePgDatabase;
});

afterEach(async () => database.close());

describe('API mutation idempotency repository', () => {
  it('executes once and replays the stored response for the same fingerprint', async () => {
    const mutation = vi.fn(() =>
      Promise.resolve({ statusCode: 201, body: { data: { id: 'post-1' } } }),
    );
    const input: IdempotentMutationInput = {
      workspaceId,
      actor: { type: 'api-key', id: apiKeyId },
      operation: 'posts.create',
      idempotencyKey: 'request-1',
      requestFingerprint: 'fingerprint-1',
    };

    await expect(executeIdempotentMutation(db, input, mutation)).resolves.toMatchObject({
      kind: 'executed',
      response: { statusCode: 201 },
    });
    await expect(executeIdempotentMutation(db, input, mutation)).resolves.toEqual({
      kind: 'replayed',
      response: { statusCode: 201, body: { data: { id: 'post-1' } } },
    });
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it('returns a conflict without executing when the fingerprint changes', async () => {
    const input: IdempotentMutationInput = {
      workspaceId,
      actor: { type: 'api-key', id: apiKeyId },
      operation: 'posts.create',
      idempotencyKey: 'request-2',
      requestFingerprint: 'fingerprint-1',
    };
    await executeIdempotentMutation(db, input, () =>
      Promise.resolve({ statusCode: 201, body: {} }),
    );
    const mutation = vi.fn(() => Promise.resolve({ statusCode: 201, body: {} }));

    await expect(
      executeIdempotentMutation(db, { ...input, requestFingerprint: 'fingerprint-2' }, mutation),
    ).resolves.toEqual({ kind: 'conflict' });
    expect(mutation).not.toHaveBeenCalled();
  });

  it('isolates idempotency keys by machine actor type and id', async () => {
    const common = {
      workspaceId,
      operation: 'posts.create',
      idempotencyKey: 'shared-client-key',
      requestFingerprint: 'fingerprint-1',
    };
    const mutation = vi.fn(() => Promise.resolve({ statusCode: 201, body: { ok: true } }));

    await expect(
      executeIdempotentMutation(
        db,
        { ...common, actor: { type: 'api-key', id: apiKeyId } },
        mutation,
      ),
    ).resolves.toMatchObject({ kind: 'executed' });
    await expect(
      executeIdempotentMutation(
        db,
        { ...common, actor: { type: 'delegated', id: apiKeyId } },
        mutation,
      ),
    ).resolves.toMatchObject({ kind: 'executed' });
    expect(mutation).toHaveBeenCalledTimes(2);
  });

  it('rolls back the reservation when the mutation fails', async () => {
    const input: IdempotentMutationInput = {
      workspaceId,
      actor: { type: 'api-key', id: apiKeyId },
      operation: 'posts.create',
      idempotencyKey: 'request-3',
      requestFingerprint: 'fingerprint-1',
    };
    await expect(
      executeIdempotentMutation(db, input, () => Promise.reject(new Error('mutation failed'))),
    ).rejects.toThrow('mutation failed');
    await expect(
      executeIdempotentMutation(db, input, () =>
        Promise.resolve({ statusCode: 201, body: { ok: true } }),
      ),
    ).resolves.toMatchObject({ kind: 'executed' });
  });
});
