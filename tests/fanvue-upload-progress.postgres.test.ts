import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getActiveCredential } from '../src/modules/credentials/credential.repository.js';
import { decryptCredential } from '../src/modules/credentials/envelope.js';
import { advanceFanvueUploadProgress } from '../src/modules/providers/fanvue-upload-progress.repository.js';
import type { FanvueUploadSession } from '../src/modules/providers/fanvue-upload-session.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000002';
const accountId = '00000000-0000-4000-8000-000000000003';
const jobId = '00000000-0000-4000-8000-000000000004';
const artifactId = '00000000-0000-4000-8000-000000000005';
const credentialId = '00000000-0000-4000-8000-000000000006';
const now = new Date('2026-10-25T09:00:00.000Z');
const keys = { currentVersion: () => 'v1', getKey: () => Promise.resolve(Buffer.alloc(32, 7)) };
const session: FanvueUploadSession = {
  uploadId: 'upload-one',
  mediaUuid: '00000000-0000-4000-8000-000000000007',
  byteSize: 8,
  partSize: 5,
  partCount: 2,
  parts: [],
};

let postgres: PGlite;
let database: NodePgDatabase;

beforeEach(async () => {
  postgres = new PGlite();
  await postgres.exec(`
    CREATE TABLE credentials (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, key_version text NOT NULL,
      wrapped_key bytea NOT NULL, wrapped_key_nonce bytea NOT NULL,
      wrapped_key_tag bytea NOT NULL, ciphertext bytea NOT NULL,
      nonce bytea NOT NULL, tag bytea NOT NULL, version integer NOT NULL,
      revoked_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE provider_accounts (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, destination_provider text NOT NULL,
      availability text NOT NULL, disconnected_at timestamptz
    );
    CREATE TABLE publication_jobs (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, provider_account_id uuid NOT NULL,
      state text NOT NULL, lease_owner text, lease_expires_at timestamptz
    );
    CREATE TABLE publication_attempts (workspace_id uuid NOT NULL, job_id uuid NOT NULL);
    CREATE TABLE provider_staging_artifacts (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, job_id uuid NOT NULL,
      provider_reference_credential_id uuid, upload_phase text NOT NULL,
      next_segment integer NOT NULL, next_byte_offset bigint NOT NULL,
      expires_at timestamptz NOT NULL, deleted_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await postgres.query(
    `INSERT INTO credentials (
       id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag,
       ciphertext, nonce, tag, version
     ) VALUES ($1, $2, 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06', 1)`,
    [credentialId, workspaceId],
  );
  await postgres.query(`INSERT INTO provider_accounts VALUES ($1, $2, 'fanvue', 'active', NULL)`, [
    accountId,
    workspaceId,
  ]);
  await postgres.query(
    `INSERT INTO publication_jobs VALUES ($1, $2, $3, 'leased', 'worker-one', $4)`,
    [jobId, workspaceId, accountId, new Date(now.getTime() + 60_000)],
  );
  await postgres.query(
    `INSERT INTO provider_staging_artifacts (
       id, workspace_id, job_id, provider_reference_credential_id, upload_phase,
       next_segment, next_byte_offset, expires_at
     ) VALUES ($1, $2, $3, $4, 'uploading', 0, 0, $5)`,
    [artifactId, workspaceId, jobId, credentialId, new Date(now.getTime() + 60_000)],
  );
  database = drizzle(postgres) as unknown as NodePgDatabase;
});

afterEach(async () => postgres.close());

async function progress() {
  const artifact = await postgres.query<{ next_segment: number; next_byte_offset: string }>(
    'SELECT next_segment, next_byte_offset FROM provider_staging_artifacts WHERE id=$1',
    [artifactId],
  );
  const credential = await postgres.query<{ version: number }>(
    'SELECT version FROM credentials WHERE id=$1',
    [credentialId],
  );
  return {
    segment: artifact.rows[0]?.next_segment,
    offset: Number(artifact.rows[0]?.next_byte_offset),
    version: credential.rows[0]?.version,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    jobId,
    artifactId,
    leaseOwner: 'worker-one',
    credentialId,
    credentialVersion: 1,
    session,
    partNumber: 1,
    etag: 'etag-one',
    now,
    ...overrides,
  };
}

describe('Fanvue encrypted session and staging progress transaction', () => {
  it('commits one receipt and offset, refusing duplicate/stale progress', async () => {
    expect(await advanceFanvueUploadProgress(database, keys, input())).toBe(true);
    expect(await progress()).toEqual({ segment: 1, offset: 5, version: 2 });
    const stored = await getActiveCredential(database, workspaceId, credentialId);
    if (!stored) throw new Error('Missing upload session receipt');
    expect(JSON.parse((await decryptCredential(stored, keys)).toString())).toEqual({
      ...session,
      parts: [{ PartNumber: 1, ETag: 'etag-one' }],
    });
    expect(await advanceFanvueUploadProgress(database, keys, input())).toBe(false);
    expect(await progress()).toEqual({ segment: 1, offset: 5, version: 2 });
    expect(
      await advanceFanvueUploadProgress(
        database,
        keys,
        input({
          credentialVersion: 2,
          session: { ...session, parts: [{ PartNumber: 1, ETag: 'etag-one' }] },
          partNumber: 2,
          etag: 'etag-two',
        }),
      ),
    ).toBe(true);
    expect(await progress()).toEqual({ segment: 2, offset: 8, version: 3 });
  });

  it('rolls back offset when credential version is stale', async () => {
    await expect(
      advanceFanvueUploadProgress(database, keys, input({ credentialVersion: 2 })),
    ).rejects.toThrow('version changed');
    expect(await progress()).toEqual({ segment: 0, offset: 0, version: 1 });
  });

  it('denies wrong tenant, lease owner, expired lease and a recorded attempt', async () => {
    for (const denied of [
      input({ workspaceId: otherWorkspaceId }),
      input({ leaseOwner: 'worker-two' }),
      input({ now: new Date(now.getTime() + 120_000) }),
    ])
      expect(await advanceFanvueUploadProgress(database, keys, denied)).toBe(false);
    await postgres.query('INSERT INTO publication_attempts VALUES ($1, $2)', [workspaceId, jobId]);
    expect(await advanceFanvueUploadProgress(database, keys, input())).toBe(false);
    expect(await progress()).toEqual({ segment: 0, offset: 0, version: 1 });
  });
});
