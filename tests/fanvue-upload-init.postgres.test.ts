import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getActiveCredential } from '../src/modules/credentials/credential.repository.js';
import { decryptCredential } from '../src/modules/credentials/envelope.js';
import {
  recordFanvueUploadSession,
  reserveFanvueUploadSession,
} from '../src/modules/providers/fanvue-upload-init.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000002';
const accountId = '00000000-0000-4000-8000-000000000003';
const jobId = '00000000-0000-4000-8000-000000000004';
const mediaId = '00000000-0000-4000-8000-000000000005';
const artifactId = '00000000-0000-4000-8000-000000000006';
const revisionId = '00000000-0000-4000-8000-000000000007';
const keys = { currentVersion: () => 'v1', getKey: () => Promise.resolve(Buffer.alloc(32, 7)) };
const input = { workspaceId, jobId, mediaId, artifactId, leaseOwner: 'worker-one' };
const session = {
  uploadId: 'upload-one',
  mediaUuid: '00000000-0000-4000-8000-000000000008',
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
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
      key_version text NOT NULL, wrapped_key bytea NOT NULL,
      wrapped_key_nonce bytea NOT NULL, wrapped_key_tag bytea NOT NULL,
      ciphertext bytea NOT NULL, nonce bytea NOT NULL, tag bytea NOT NULL,
      version integer NOT NULL DEFAULT 1, revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE provider_accounts (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, destination_provider text NOT NULL,
      availability text NOT NULL, disconnected_at timestamptz
    );
    CREATE TABLE publication_jobs (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, provider_account_id uuid NOT NULL,
      revision_id uuid NOT NULL, state text NOT NULL, lease_owner text, lease_expires_at timestamptz
    );
    CREATE TABLE revision_media (workspace_id uuid NOT NULL, revision_id uuid NOT NULL, media_id uuid NOT NULL);
    CREATE TABLE media_objects (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, state text NOT NULL, deleted_at timestamptz);
    CREATE TABLE publication_attempts (workspace_id uuid NOT NULL, job_id uuid NOT NULL,
      finished_at timestamptz, outcome text);
    CREATE TABLE provider_staging_artifacts (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, job_id uuid NOT NULL,
      media_id uuid, provider_reference text NOT NULL, provider_reference_credential_id uuid,
      upload_phase text NOT NULL, next_segment integer NOT NULL, next_byte_offset bigint NOT NULL,
      expires_at timestamptz NOT NULL, deleted_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const expiry = new Date(Date.now() + 60_000);
  await postgres.query(`INSERT INTO provider_accounts VALUES ($1,$2,'fanvue','active',NULL)`, [
    accountId,
    workspaceId,
  ]);
  await postgres.query(
    `INSERT INTO publication_jobs VALUES ($1,$2,$3,$4,'leased','worker-one',$5)`,
    [jobId, workspaceId, accountId, revisionId, expiry],
  );
  await postgres.query(`INSERT INTO media_objects VALUES ($1,$2,'ready',NULL)`, [
    mediaId,
    workspaceId,
  ]);
  await postgres.query(`INSERT INTO revision_media VALUES ($1,$2,$3)`, [
    workspaceId,
    revisionId,
    mediaId,
  ]);
  await postgres.query(
    `INSERT INTO provider_staging_artifacts VALUES
    ($1,$2,$3,$4,'fanvue:multipart',NULL,'initialized',0,0,$5,NULL,now())`,
    [artifactId, workspaceId, jobId, mediaId, expiry],
  );
  database = drizzle(postgres) as unknown as NodePgDatabase;
});

afterEach(async () => postgres.close());

describe('Fanvue create-session intent and receipt', () => {
  it('reserves once before provider call, then stores the exact encrypted session', async () => {
    expect(
      await reserveFanvueUploadSession(database, { ...input, workspaceId: otherWorkspaceId }),
    ).toBe(false);
    expect(
      await reserveFanvueUploadSession(database, { ...input, mediaId: otherWorkspaceId }),
    ).toBe(false);
    expect(await reserveFanvueUploadSession(database, input)).toBe(true);
    expect(await reserveFanvueUploadSession(database, input)).toBe(false);
    await postgres.query('UPDATE publication_jobs SET lease_expires_at=$1 WHERE id=$2', [
      new Date(Date.now() - 60_000),
      jobId,
    ]);
    const recorded = await recordFanvueUploadSession(database, keys, { ...input, session });
    if (!recorded) throw new Error('Fanvue upload session was not recorded');
    expect(recorded.credentialVersion).toBe(1);
    expect(await recordFanvueUploadSession(database, keys, { ...input, session })).toBeNull();
    const artifact = await postgres.query<{
      upload_phase: string;
      provider_reference_credential_id: string;
    }>(
      'SELECT upload_phase, provider_reference_credential_id FROM provider_staging_artifacts WHERE id=$1',
      [artifactId],
    );
    expect(artifact.rows[0]?.upload_phase).toBe('uploading');
    expect(artifact.rows[0]?.provider_reference_credential_id).toBe(recorded.credentialId);
    const credential = await getActiveCredential(database, workspaceId, recorded.credentialId);
    if (!credential) throw new Error('Fanvue upload credential was not stored');
    expect(JSON.parse((await decryptCredential(credential, keys)).toString())).toEqual(session);
  });

  it('rejects stale lease, disconnected account and an existing publication attempt', async () => {
    await postgres.query('UPDATE publication_jobs SET lease_expires_at=$1 WHERE id=$2', [
      new Date(Date.now() - 60_000),
      jobId,
    ]);
    expect(await reserveFanvueUploadSession(database, input)).toBe(false);
    await postgres.query('UPDATE publication_jobs SET lease_expires_at=$1 WHERE id=$2', [
      new Date(Date.now() + 60_000),
      jobId,
    ]);
    await postgres.query('UPDATE provider_accounts SET disconnected_at=now() WHERE id=$1', [
      accountId,
    ]);
    expect(await reserveFanvueUploadSession(database, input)).toBe(false);
    await postgres.query('UPDATE provider_accounts SET disconnected_at=NULL WHERE id=$1', [
      accountId,
    ]);
    await postgres.query('INSERT INTO publication_attempts VALUES ($1,$2)', [workspaceId, jobId]);
    expect(await reserveFanvueUploadSession(database, input)).toBe(false);
  });
});
