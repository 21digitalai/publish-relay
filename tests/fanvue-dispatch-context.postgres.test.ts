import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  assertFanvueDispatchPreflight,
  loadFanvueDispatchContext,
} from '../src/modules/providers/fanvue-dispatch-context.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const jobId = '00000000-0000-4000-8000-000000000003';
const revisionId = '00000000-0000-4000-8000-000000000004';
const mediaId = '00000000-0000-4000-8000-000000000005';
const creatorId = '00000000-0000-4000-8000-000000000006';
const connectionId = '00000000-0000-4000-8000-000000000007';
const selected = { workspaceId, jobId, leaseOwner: 'worker-one' };
let postgres: PGlite;
let database: NodePgDatabase;

beforeEach(async () => {
  postgres = new PGlite();
  await postgres.exec(`
    CREATE TABLE provider_connections (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, provider text NOT NULL,
      external_subject_id text NOT NULL,
      status text NOT NULL, revoked_at timestamptz
    );
    CREATE TABLE provider_accounts (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, connection_id uuid NOT NULL,
      remote_account_id text NOT NULL, destination_provider text NOT NULL,
      availability text NOT NULL, disconnected_at timestamptz
    );
    CREATE TABLE publication_jobs (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, provider_account_id uuid NOT NULL,
      revision_id uuid NOT NULL, effective_payload jsonb NOT NULL, state text NOT NULL,
      lease_owner text, lease_expires_at timestamptz
    );
    CREATE TABLE revision_media (
      workspace_id uuid NOT NULL, revision_id uuid NOT NULL, media_id uuid NOT NULL,
      position integer NOT NULL
    );
    CREATE TABLE media_objects (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, state text NOT NULL,
      deleted_at timestamptz
    );
    CREATE TABLE provider_staging_artifacts (
      workspace_id uuid NOT NULL, job_id uuid NOT NULL, media_id uuid NOT NULL,
      provider_reference text NOT NULL, upload_phase text NOT NULL,
      external_object_id text, deleted_at timestamptz, expires_at timestamptz NOT NULL
    );
  `);
  await postgres.query(
    `INSERT INTO provider_connections VALUES ($1,$2,'fanvue',$3,'active',NULL)`,
    [connectionId, workspaceId, creatorId],
  );
  await postgres.query(
    `INSERT INTO provider_accounts VALUES ($1,$2,$3,$4,'fanvue','active',NULL)`,
    [accountId, workspaceId, connectionId, creatorId],
  );
  await postgres.query(
    `INSERT INTO publication_jobs VALUES ($1,$2,$3,$4,$5,'leased','worker-one',$6)`,
    [
      jobId,
      workspaceId,
      accountId,
      revisionId,
      JSON.stringify({
        schemaVersion: 1,
        kind: 'post',
        audience: 'subscribers',
        text: 'Hello',
        mediaIds: [mediaId],
      }),
      new Date(Date.now() + 60_000),
    ],
  );
  await postgres.query('INSERT INTO media_objects VALUES ($1,$2,$3,NULL)', [
    mediaId,
    workspaceId,
    'ready',
  ]);
  await postgres.query('INSERT INTO revision_media VALUES ($1,$2,$3,0)', [
    workspaceId,
    revisionId,
    mediaId,
  ]);
  database = drizzle(postgres) as unknown as NodePgDatabase;
});

afterEach(async () => postgres.close());

it('selects only the leased creator and matching ready revision media', async () => {
  const result = await loadFanvueDispatchContext(database, selected);
  expect(result.creatorId).toBe(creatorId);
  expect(result.content.mediaIds).toEqual([mediaId]);
  await expect(
    loadFanvueDispatchContext(database, { ...selected, workspaceId: creatorId }),
  ).rejects.toThrow('unavailable');
});

it('denies detached or not-ready media and disconnected creator', async () => {
  await postgres.query("UPDATE media_objects SET state='processing'");
  await expect(loadFanvueDispatchContext(database, selected)).rejects.toThrow('ready revision');
  await postgres.query("UPDATE media_objects SET state='ready'");
  await postgres.query('DELETE FROM revision_media');
  await expect(loadFanvueDispatchContext(database, selected)).rejects.toThrow('ready revision');
  await postgres.query('INSERT INTO revision_media VALUES ($1,$2,$3,0)', [
    workspaceId,
    revisionId,
    mediaId,
  ]);
  await postgres.query('UPDATE provider_accounts SET disconnected_at=now()');
  await expect(loadFanvueDispatchContext(database, selected)).rejects.toThrow('unavailable');
});

it('rechecks creator and finalized media inside attempt reservation', async () => {
  await postgres.query("UPDATE publication_jobs SET state='dispatching'");
  const preflight = {
    workspaceId,
    jobId,
    creatorId,
    mediaIds: [mediaId],
    readyMedia: new Map([[mediaId, creatorId]]),
  };
  await expect(assertFanvueDispatchPreflight(database, preflight)).rejects.toThrow('media changed');
  await postgres.query(
    `INSERT INTO provider_staging_artifacts VALUES ($1,$2,$3,'fanvue:multipart','finalized',$4,NULL,$5)`,
    [workspaceId, jobId, mediaId, creatorId, new Date(Date.now() + 60_000)],
  );
  await expect(assertFanvueDispatchPreflight(database, preflight)).resolves.toBeUndefined();
  await expect(
    assertFanvueDispatchPreflight(database, {
      ...preflight,
      readyMedia: new Map([[mediaId, connectionId]]),
    }),
  ).rejects.toThrow('media changed');
  await expect(
    assertFanvueDispatchPreflight(database, { ...preflight, creatorId: mediaId }),
  ).rejects.toThrow('destination changed');
  await postgres.query("UPDATE provider_staging_artifacts SET upload_phase='processing'");
  await expect(assertFanvueDispatchPreflight(database, preflight)).rejects.toThrow('media changed');
});
