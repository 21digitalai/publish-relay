import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reserveFanvueStagingArtifact } from '../src/modules/providers/fanvue-artifact.repository.js';
import { getFanvueJobMediaMetadata } from '../src/modules/providers/fanvue-job-media-source.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const jobId = '00000000-0000-4000-8000-000000000003';
const revisionId = '00000000-0000-4000-8000-000000000004';
const mediaId = '00000000-0000-4000-8000-000000000005';
const input = {
  workspaceId,
  jobId,
  mediaId,
  leaseOwner: 'worker-one',
  expiresAt: new Date(Date.now() + 60_000),
};
let postgres: PGlite;
let database: NodePgDatabase;

beforeEach(async () => {
  postgres = new PGlite();
  await postgres.exec(`
    CREATE TABLE provider_accounts (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, destination_provider text NOT NULL,
      availability text NOT NULL, disconnected_at timestamptz
    );
    CREATE TABLE publication_jobs (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, provider_account_id uuid NOT NULL,
      revision_id uuid NOT NULL, state text NOT NULL, lease_owner text, lease_expires_at timestamptz
    );
    CREATE TABLE revision_media (workspace_id uuid NOT NULL, revision_id uuid NOT NULL, media_id uuid NOT NULL);
    CREATE TABLE media_objects (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, storage_key text NOT NULL, sha256 text NOT NULL,
      byte_size bigint NOT NULL, mime_type text NOT NULL, state text NOT NULL, deleted_at timestamptz
    );
    CREATE TABLE publication_attempts (workspace_id uuid NOT NULL, job_id uuid NOT NULL);
    CREATE TABLE provider_staging_artifacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, job_id uuid NOT NULL,
      media_id uuid NOT NULL, provider_reference text NOT NULL, expires_at timestamptz NOT NULL,
      UNIQUE (workspace_id, job_id, media_id)
    );
  `);
  await postgres.query(`INSERT INTO provider_accounts VALUES ($1,$2,'fanvue','active',NULL)`, [
    accountId,
    workspaceId,
  ]);
  await postgres.query(
    `INSERT INTO publication_jobs VALUES ($1,$2,$3,$4,'leased','worker-one',$5)`,
    [jobId, workspaceId, accountId, revisionId, new Date(Date.now() + 60_000)],
  );
  await postgres.query(
    `INSERT INTO media_objects VALUES ($1,$2,'key','hash',8,'image/jpeg','ready',NULL)`,
    [mediaId, workspaceId],
  );
  await postgres.query(`INSERT INTO revision_media VALUES ($1,$2,$3)`, [
    workspaceId,
    revisionId,
    mediaId,
  ]);
  database = drizzle(postgres) as unknown as NodePgDatabase;
});

afterEach(async () => postgres.close());

describe('Fanvue guarded artifact insertion', () => {
  it('creates one artifact only for an eligible selected job/media', async () => {
    expect(await reserveFanvueStagingArtifact(database, input)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await reserveFanvueStagingArtifact(database, input)).toBeNull();
    const rows = await postgres.query('SELECT id FROM provider_staging_artifacts');
    expect(rows.rows).toHaveLength(1);
  });

  it('leaves no artifact when the lease expires after a successful preflight', async () => {
    expect(await getFanvueJobMediaMetadata(database, input)).toEqual({
      byteSize: 8,
      mimeType: 'image/jpeg',
    });
    await postgres.query('UPDATE publication_jobs SET lease_expires_at=$1 WHERE id=$2', [
      new Date(Date.now() - 60_000),
      jobId,
    ]);
    expect(await reserveFanvueStagingArtifact(database, input)).toBeNull();
    const rows = await postgres.query('SELECT id FROM provider_staging_artifacts');
    expect(rows.rows).toHaveLength(0);
  });

  it('denies disconnected account and recorded attempt', async () => {
    await postgres.query('UPDATE provider_accounts SET disconnected_at=now() WHERE id=$1', [
      accountId,
    ]);
    expect(await reserveFanvueStagingArtifact(database, input)).toBeNull();
    await postgres.query('UPDATE provider_accounts SET disconnected_at=NULL WHERE id=$1', [
      accountId,
    ]);
    await postgres.query('INSERT INTO publication_attempts VALUES ($1,$2)', [workspaceId, jobId]);
    expect(await reserveFanvueStagingArtifact(database, input)).toBeNull();
  });
});
