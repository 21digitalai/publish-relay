import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import cookie from '@fastify/cookie';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getTikTokPublicationConsent,
  issueTikTokPublicationConsent,
  tiktokConsentRequestSchema,
  verifyTikTokPublicationConsent,
  verifyTikTokPublicationConsentInTransaction,
  type TikTokConsentCommand,
} from '../src/modules/providers/tiktok-consent.service.js';
import { createPost } from '../src/modules/content/post.service.js';
import { registerTikTokConsentRoutes } from '../src/modules/providers/tiktok-consent.routes.js';
import {
  getPreparedTikTokDraft,
  listPreparedTikTokDrafts,
  prepareTikTokDraft,
  revisePreparedTikTokDraftInTransaction,
} from '../src/modules/providers/tiktok-draft.service.js';
import { registerTikTokDraftRoutes } from '../src/modules/providers/tiktok-draft.routes.js';
import { registerTikTokScheduleRoutes } from '../src/modules/providers/tiktok-schedule.routes.js';
import { scheduleTikTokDraft } from '../src/modules/providers/tiktok-schedule.service.js';
import type { AuthService } from '../src/modules/identity/auth.service.js';
import { allowAllActionPolicy } from '../src/modules/policy/action-policy.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';

const migrationNames = [
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
  '0055_x_long_post_declaration',
  '0114_publication_approval_hold',
];
const workspaceId = '00000000-0000-4000-8000-000000000101';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000201';
const userId = '00000000-0000-4000-8000-000000000102';
const machineId = '00000000-0000-4000-8000-000000000103';
const postId = '00000000-0000-4000-8000-000000000301';
const revisionId = '00000000-0000-4000-8000-000000000302';
const mediaId = '00000000-0000-4000-8000-000000000401';
const accountId = '00000000-0000-4000-8000-000000000501';
const connectionId = '00000000-0000-4000-8000-000000000601';
const credentialId = '00000000-0000-4000-8000-000000000701';
const snapshotId = '00000000-0000-4000-8000-000000000801';
const mediaHash = 'a'.repeat(64);
let pg: PGlite;
let db: NodePgDatabase;

function command(): TikTokConsentCommand {
  return {
    workspaceId,
    userId,
    actor: { type: 'user', id: userId },
    postId,
    revisionId,
    accountId,
    capabilitySnapshotId: snapshotId,
    options: {
      privacyLevel: 'SELF_ONLY',
      allowComment: false,
      allowDuet: false,
      allowStitch: false,
      commercialContent: 'none',
      aiGenerated: false,
    },
    musicUsageConfirmed: true,
    brandedContentPolicyConfirmed: false,
  };
}

function content(input = command()) {
  return JSON.stringify({
    schemaVersion: 1,
    kind: 'video',
    caption: 'Exact caption',
    mediaId,
    options: input.options,
  });
}

beforeEach(async () => {
  pg = new PGlite();
  for (const name of migrationNames)
    await pg.exec(await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8'));
  db = drizzle(pg) as unknown as NodePgDatabase;
  await pg.exec(`
    insert into workspaces (id, name, slug) values
      ('${workspaceId}', 'One', 'one'), ('${otherWorkspaceId}', 'Two', 'two');
    insert into users (id, email, password_hash) values ('${userId}', 'owner@example.test', 'redacted');
    insert into memberships (workspace_id, user_id, role) values ('${workspaceId}', '${userId}', 'owner');
    insert into credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
      wrapped_key_tag, ciphertext, nonce, tag)
      values ('${credentialId}', '${workspaceId}', 'fixture', '\\x01', '\\x01', '\\x01',
      '\\x01', '\\x01', '\\x01');
    insert into provider_connections (id, workspace_id, provider, external_subject_id,
      credential_id, scopes, refresh_expires_at)
      values ('${connectionId}', '${workspaceId}', 'tiktok', 'subject-one',
      '${credentialId}', '["video.publish"]', now() + interval '1 day');
    insert into provider_accounts (id, workspace_id, connection_id, provider_account_id,
      destination_provider, remote_account_id, display_name)
      values ('${accountId}', '${workspaceId}', '${connectionId}', 'subject-one',
      'tiktok', 'subject-one', 'One');
    insert into media_objects (id, workspace_id, storage_key, sha256, mime_type, byte_size,
      duration_ms, width, height, video_codec, container, state)
      values ('${mediaId}', '${workspaceId}', 'fixture.mp4', '${mediaHash}',
      'video/mp4', 1024, 30000, 1080, 1920, 'h264', 'mp4', 'ready');
    insert into posts (id, workspace_id, created_by_user_id)
      values ('${postId}', '${workspaceId}', '${userId}');
    insert into post_revisions (id, workspace_id, post_id, revision_number, content)
      values ('${revisionId}', '${workspaceId}', '${postId}', 1, '${content()}');
    insert into revision_media (workspace_id, revision_id, media_id, position)
      values ('${workspaceId}', '${revisionId}', '${mediaId}', 0);
    insert into provider_capability_snapshots (id, workspace_id, account_id, connection_id,
      external_subject_id, credential_version, nickname, privacy_options,
      comment_disabled, duet_disabled, stitch_disabled, max_video_duration_seconds,
      fetched_at, expires_at)
      values ('${snapshotId}', '${workspaceId}', '${accountId}', '${connectionId}',
      'subject-one', 1, 'One', '["SELF_ONLY", "PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS"]',
      false, true, true, 120, now() - interval '1 minute', now() + interval '14 minutes');
  `);
});
afterEach(async () => pg.close());

it('reads only bounded prepared-draft fields and revises immutably with exact replay', async () => {
  const preparedContent = {
    schemaVersion: 1 as const,
    kind: 'video' as const,
    caption: 'Exact caption',
    mediaId,
    options: command().options,
  };
  const initial = await getPreparedTikTokDraft(db, { workspaceId, userId, postId });
  expect(initial).toMatchObject({ postId, revisionId, media: { id: mediaId, ready: true } });
  expect(JSON.stringify(initial)).not.toMatch(/storageKey|sha256|credential|fixture\.mp4/);
  expect(await listPreparedTikTokDrafts(db, { workspaceId, userId, limit: 1 })).toHaveLength(1);
  await expect(
    getPreparedTikTokDraft(db, { workspaceId: otherWorkspaceId, userId, postId }),
  ).rejects.toThrow();
  const same = await withTenantTransaction(db, { workspaceId, userId }, (transaction) =>
    revisePreparedTikTokDraftInTransaction(transaction, {
      workspaceId,
      userId,
      postId,
      content: preparedContent,
      requestId: 'same',
    }),
  );
  expect(same).toEqual({ postId, revisionId, changed: false });
  const changed = await withTenantTransaction(db, { workspaceId, userId }, (transaction) =>
    revisePreparedTikTokDraftInTransaction(transaction, {
      workspaceId,
      userId,
      postId,
      content: { ...preparedContent, caption: 'Corrected caption' },
      requestId: 'changed',
    }),
  );
  expect(changed.changed).toBe(true);
  expect(changed.revisionId).not.toBe(revisionId);
  const replay = await withTenantTransaction(db, { workspaceId, userId }, (transaction) =>
    revisePreparedTikTokDraftInTransaction(transaction, {
      workspaceId,
      userId,
      postId,
      content: { ...preparedContent, caption: 'Corrected caption' },
      requestId: 'replay',
    }),
  );
  expect(replay).toEqual({ ...changed, changed: false });
  const rows = await pg.query<{ revision_count: number; media_count: number }>(
    `select (select count(*)::int from post_revisions where post_id = $1) as revision_count,
      (select count(*)::int from revision_media where media_id = $2) as media_count`,
    [postId, mediaId],
  );
  expect(rows.rows[0]).toEqual({ revision_count: 2, media_count: 2 });
  await pg.query(
    `insert into publication_jobs (workspace_id, post_id, revision_id, provider_account_id,
    scheduled_at, effective_payload) values ($1, $2, $3, $4, now() + interval '1 day', '{}')`,
    [workspaceId, postId, changed.revisionId, accountId],
  );
  await expect(getPreparedTikTokDraft(db, { workspaceId, userId, postId })).rejects.toThrow();
  await expect(
    withTenantTransaction(db, { workspaceId, userId }, (transaction) =>
      revisePreparedTikTokDraftInTransaction(transaction, {
        workspaceId,
        userId,
        postId,
        content: preparedContent,
        requestId: 'after-job',
      }),
    ),
  ).rejects.toThrow('already scheduled');
});

it('prepares one canonical unscheduled TikTok revision before human consent', async () => {
  const draft = {
    workspaceId,
    userId,
    accountId,
    requestId: 'draft-preparation',
    content: {
      schemaVersion: 1 as const,
      kind: 'video' as const,
      caption: 'Draft caption',
      mediaId,
      options: command().options,
    },
  };
  await expect(prepareTikTokDraft(db, { ...draft, workspaceId: otherWorkspaceId })).rejects.toThrow(
    'invalid',
  );
  await expect(
    prepareTikTokDraft(db, {
      ...draft,
      content: { ...draft.content, mediaId: '00000000-0000-4000-8000-000000000499' },
    }),
  ).rejects.toThrow('invalid');
  const prepared = await prepareTikTokDraft(db, draft);
  const rows = await pg.query<{ content: unknown; job_count: number }>(
    `select r.content, (select count(*)::int from publication_jobs j where j.post_id = p.id) as job_count
     from posts p join post_revisions r on r.workspace_id = p.workspace_id and r.post_id = p.id
     where p.id = $1`,
    [prepared.postId],
  );
  expect(rows.rows).toEqual([{ content: draft.content, job_count: 0 }]);
  const receipt = await issueTikTokPublicationConsent(db, {
    ...command(),
    postId: prepared.postId,
    revisionId: prepared.revisionId,
    options: draft.content.options,
  });
  expect(receipt.id).toBeTruthy();
  const verified = await withTenantTransaction(db, { workspaceId }, (transaction) =>
    verifyTikTokPublicationConsentInTransaction(transaction, {
      workspaceId,
      postId: prepared.postId,
      revisionId: prepared.revisionId,
      accountId,
      receiptId: receipt.id,
      actor: { type: 'user', id: userId },
    }),
  );
  expect(verified.revisionId).toBe(prepared.revisionId);
  expect(
    (await pg.query('select id from publication_jobs where post_id = $1', [prepared.postId])).rows,
  ).toHaveLength(0);
});

it('prepares a draft through session, CSRF and idempotent browser admission', async () => {
  const app = Fastify();
  await app.register(cookie);
  const auth = {
    authenticate: (tenant: string) =>
      Promise.resolve(tenant === workspaceId ? { workspaceId, userId, role: 'owner' } : null),
  } as unknown as AuthService;
  registerTikTokDraftRoutes(app, { auth, database: db, actionPolicy: allowAllActionPolicy });
  const payload = { accountId, content: JSON.parse(content()) as Record<string, unknown> };
  const url = '/api/workflow/tiktok-drafts';
  const headers = {
    cookie: `publish_relay_session=${workspaceId}.token; publish_relay_csrf=csrf`,
    'x-csrf-token': 'csrf',
    'idempotency-key': 'draft-replay-key',
  };
  expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
  expect(
    (await app.inject({ method: 'POST', url, payload, headers: { cookie: headers.cookie } }))
      .statusCode,
  ).toBe(403);
  const first = await app.inject({ method: 'POST', url, payload, headers });
  expect(first.statusCode, first.body).toBe(201);
  const second = await app.inject({ method: 'POST', url, payload, headers });
  expect(second.statusCode).toBe(201);
  expect(second.headers['idempotency-replayed']).toBe('true');
  expect(second.json()).toEqual(first.json());
  const prepared = first.json<{ data: { postId: string } }>().data;
  await pg.query(
    `update posts set created_at = case when id = $1
    then '2026-10-20T00:00:00.123456Z'::timestamptz
    else '2026-10-20T00:00:00.123123Z'::timestamptz end
    where id in ($1, $2)`,
    [prepared.postId, postId],
  );
  const detailUrl = `${url}/${prepared.postId}`;
  const detail = await app.inject({ method: 'GET', url: detailUrl, headers });
  expect(detail.statusCode).toBe(200);
  expect(detail.json<{ data: { content: { caption: string } } }>().data.content.caption).toBe(
    'Exact caption',
  );
  expect(JSON.stringify(detail.json())).not.toMatch(/storageKey|sha256|credential|fixture\.mp4/);
  const listed = await app.inject({ method: 'GET', url: `${url}?limit=1`, headers });
  expect(listed.statusCode).toBe(200);
  const listData = listed.json<{
    data: { postId: string; createdAt: string; captionPreview: string; content?: unknown }[];
  }>().data;
  expect(listData).toHaveLength(1);
  expect(listData[0]?.content).toBeUndefined();
  expect(listData[0]?.captionPreview).toBeTruthy();
  expect(listData[0]?.createdAt).toBe('2026-10-20T00:00:00.123456Z');
  expect(JSON.stringify(listData).length).toBeLessThan(1000);
  expect(
    (await app.inject({ method: 'GET', url: `${url}?beforeId=${postId}`, headers })).statusCode,
  ).toBe(400);
  const firstItem = listData[0];
  if (!firstItem) throw new Error('Expected a prepared item');
  const olderPage = await app.inject({
    method: 'GET',
    url: `${url}?limit=1&before=${encodeURIComponent(firstItem.createdAt)}&beforeId=${firstItem.postId}`,
    headers,
  });
  expect(olderPage.statusCode, olderPage.body).toBe(200);
  expect(olderPage.json<{ data: unknown[] }>().data).toHaveLength(1);
  expect(olderPage.json<{ data: { postId: string }[] }>().data[0]?.postId).toBe(postId);
  const patchHeaders = { ...headers, 'idempotency-key': 'draft-revision-key' };
  const patchPayload = { content: { ...payload.content, caption: 'Corrected caption' } };
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: detailUrl,
        payload: patchPayload,
        headers: { cookie: headers.cookie },
      })
    ).statusCode,
  ).toBe(403);
  const revision = await app.inject({
    method: 'PATCH',
    url: detailUrl,
    payload: patchPayload,
    headers: patchHeaders,
  });
  expect(revision.statusCode, revision.body).toBe(200);
  const revisionReplay = await app.inject({
    method: 'PATCH',
    url: detailUrl,
    payload: patchPayload,
    headers: patchHeaders,
  });
  expect(revisionReplay.statusCode).toBe(200);
  expect(revisionReplay.headers['idempotency-replayed']).toBe('true');
  expect(revisionReplay.json()).toEqual(revision.json());
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: detailUrl,
        payload: { content: { ...payload.content, caption: 'Conflicting' } },
        headers: patchHeaders,
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (await pg.query('select count(*)::int as count from posts where id = $1', [prepared.postId]))
      .rows[0],
  ).toEqual({ count: 1 });
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        payload: { ...payload, content: { ...payload.content, caption: 'Changed' } },
        headers,
      })
    ).statusCode,
  ).toBe(409);
  await app.close();
});

it('admits one consent-bound TikTok job through the tenant application boundary', async () => {
  const receipt = await issueTikTokPublicationConsent(db, command());
  const input = {
    workspaceId,
    userId,
    postId,
    revisionId,
    accountId,
    receiptId: receipt.id,
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    approvalRequired: true,
    requestId: 'schedule-fixture',
    idempotencyKey: 'schedule-fixture',
  };
  await expect(
    scheduleTikTokDraft(db, { ...input, workspaceId: otherWorkspaceId }),
  ).rejects.toThrow('invalid');
  const scheduled = await scheduleTikTokDraft(db, input);
  const rows = await pg.query<{ id: string; effective_payload: Record<string, unknown> }>(
    'select id, effective_payload from publication_jobs where post_id = $1',
    [postId],
  );
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0]?.id).toBe(scheduled.jobId);
  expect(rows.rows[0]?.effective_payload).toMatchObject({
    destinationProvider: 'tiktok',
    consentReceiptId: receipt.id,
    mediaSha256: mediaHash,
    caption: 'Exact caption',
    options: command().options,
  });
  await expect(scheduleTikTokDraft(db, { ...input, idempotencyKey: 'another' })).rejects.toThrow(
    'already scheduled',
  );
});

it('rejects stale revision, creator capability and rotated grant before job admission', async () => {
  const receipt = await issueTikTokPublicationConsent(db, command());
  const input = {
    workspaceId,
    userId,
    postId,
    revisionId,
    accountId,
    receiptId: receipt.id,
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    requestId: 'stale-fixture',
    idempotencyKey: 'stale-fixture',
  };
  await pg.exec(`update provider_capability_snapshots set expires_at = now() - interval '1 second'
    where id = '${snapshotId}'`);
  await expect(scheduleTikTokDraft(db, input)).rejects.toThrow('invalid');
  await pg.exec(`update provider_capability_snapshots set expires_at = now() + interval '14 minutes'
    where id = '${snapshotId}'; update credentials set version = 2 where id = '${credentialId}'`);
  await expect(scheduleTikTokDraft(db, input)).rejects.toThrow('invalid');
  await pg.exec(`update credentials set version = 1 where id = '${credentialId}';
    insert into post_revisions (workspace_id, post_id, revision_number, content)
      values ('${workspaceId}', '${postId}', 2, '${content()}')`);
  await expect(scheduleTikTokDraft(db, input)).rejects.toThrow('invalid');
  expect(
    (await pg.query('select id from publication_jobs where post_id = $1', [postId])).rows,
  ).toHaveLength(0);
});

it('requires browser session, CSRF and stable idempotency for TikTok schedule admission', async () => {
  const receipt = await issueTikTokPublicationConsent(db, command());
  const app = Fastify();
  await app.register(cookie);
  const auth = {
    authenticate: (tenant: string) =>
      Promise.resolve(tenant === workspaceId ? { workspaceId, userId, role: 'owner' } : null),
  } as unknown as AuthService;
  registerTikTokScheduleRoutes(app, { auth, database: db, actionPolicy: allowAllActionPolicy });
  const url = '/api/workflow/tiktok-schedules';
  const payload = {
    postId,
    revisionId,
    accountId,
    receiptId: receipt.id,
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    approvalRequired: true,
  };
  const headers = {
    cookie: `publish_relay_session=${workspaceId}.token; publish_relay_csrf=csrf`,
    'x-csrf-token': 'csrf',
    'idempotency-key': 'schedule-browser-fixture',
  };
  expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
  expect(
    (await app.inject({ method: 'POST', url, payload, headers: { cookie: headers.cookie } }))
      .statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ method: 'POST', url, payload: { ...payload, userId }, headers }))
      .statusCode,
  ).toBe(400);
  const first = await app.inject({ method: 'POST', url, payload, headers });
  expect(first.statusCode, first.body).toBe(201);
  const held = await pg.query<{ approval_required: boolean; approved_at: Date | null }>(
    `SELECT approval_required, approved_at FROM publication_jobs WHERE post_id = '${postId}'`,
  );
  expect(held.rows[0]).toMatchObject({ approval_required: true, approved_at: null });
  expect(Buffer.byteLength(first.body)).toBeLessThan(256);
  const replay = await app.inject({ method: 'POST', url, payload, headers });
  expect(replay.json()).toEqual(first.json());
  expect(replay.headers['idempotency-replayed']).toBe('true');
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        payload: {
          ...payload,
          scheduledAt: new Date(Date.now() + 7200_000).toISOString(),
        },
        headers,
      })
    ).statusCode,
  ).toBe(409);
  await app.close();
});

describe('revision-bound TikTok consent', () => {
  it('serves the real session/CSRF route against tenant data without machine or identity bypass', async () => {
    const app = Fastify();
    await app.register(cookie);
    const auth = {
      authenticate: (tenant: string) =>
        Promise.resolve(tenant === workspaceId ? { workspaceId, userId, role: 'owner' } : null),
    } as unknown as AuthService;
    registerTikTokConsentRoutes(app, { auth, database: db });
    const request = {
      postId,
      revisionId,
      accountId,
      capabilitySnapshotId: snapshotId,
      options: command().options,
      musicUsageConfirmed: true,
      brandedContentPolicyConfirmed: false,
    };
    const url = '/api/workflow/tiktok-consents';
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { authorization: 'Bearer machine' },
          payload: request,
        })
      ).statusCode,
    ).toBe(401);
    const headers = {
      cookie: `publish_relay_session=${workspaceId}.token; publish_relay_csrf=csrf`,
      'x-csrf-token': 'csrf',
      'idempotency-key': 'exact-consent-route',
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { cookie: headers.cookie },
          payload: request,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...request, userId: machineId },
        })
      ).statusCode,
    ).toBe(400);
    const response = await app.inject({ method: 'POST', url, headers, payload: request });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Buffer.byteLength(response.body)).toBeLessThan(512);
    const receipt = response.json<{ data: { id: string } }>().data;
    const replay = await app.inject({ method: 'POST', url, headers, payload: request });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<{ data: { id: string } }>().data.id).toBe(receipt.id);
    expect(
      (
        await pg.query<{ count: number }>(
          'select count(*)::integer as count from publication_consents',
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await pg.query<{ count: number }>(
          "select count(*)::integer as count from audit_events where action = 'publication.consent'",
        )
      ).rows[0]?.count,
    ).toBe(1);
    const readUrl = `${url}/${receipt.id}`;
    const read = await app.inject({ method: 'GET', url: readUrl, headers });
    expect(read.statusCode).toBe(200);
    expect(Buffer.byteLength(read.body)).toBeLessThan(512);
    expect(read.body).not.toContain(mediaHash);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: readUrl,
          headers: { authorization: 'Bearer machine' },
        })
      ).statusCode,
    ).toBe(401);
    await pg.exec(`insert into post_revisions (workspace_id, post_id, revision_number, content)
      values ('${workspaceId}', '${postId}', 2, '${content()}')`);
    const stale = await app.inject({ method: 'GET', url: readUrl, headers });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toContain('refresh the destination');
    await app.close();
  });
  it('allows only the authenticated human principal to issue consent', async () => {
    for (const type of ['api-key', 'delegated'] as const) {
      await expect(
        issueTikTokPublicationConsent(db, {
          ...command(),
          actor: { type, id: machineId },
        }),
      ).rejects.toThrow('invalid');
    }
    await expect(
      issueTikTokPublicationConsent(db, {
        ...command(),
        actor: { type: 'user', id: '00000000-0000-4000-8000-000000000999' },
      }),
    ).rejects.toThrow('invalid');
    const rows = await pg.query('select id from publication_consents');
    expect(rows.rows).toHaveLength(0);
  });
  it('has no privacy, AI or declaration defaults in the browser command', () => {
    const valid = command();
    expect(tiktokConsentRequestSchema.safeParse(valid).success).toBe(false);
    const request = {
      postId,
      revisionId,
      accountId,
      capabilitySnapshotId: snapshotId,
      options: { ...valid.options },
      musicUsageConfirmed: true,
      brandedContentPolicyConfirmed: false,
    };
    expect(tiktokConsentRequestSchema.safeParse(request).success).toBe(true);
    const withoutPrivacy = { ...request, options: { ...request.options, privacyLevel: undefined } };
    const withoutAi = { ...request, options: { ...request.options, aiGenerated: undefined } };
    expect(tiktokConsentRequestSchema.safeParse(withoutPrivacy).success).toBe(false);
    expect(tiktokConsentRequestSchema.safeParse(withoutAi).success).toBe(false);
    expect(
      tiktokConsentRequestSchema.safeParse({ ...request, musicUsageConfirmed: undefined }).success,
    ).toBe(false);
  });
  it('issues an allowlisted immutable receipt and verifies only the exact human revision', async () => {
    const receipt = await issueTikTokPublicationConsent(db, command());
    expect(receipt.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isFinite(Date.parse(receipt.consentedAt))).toBe(true);
    const verified = await verifyTikTokPublicationConsent(db, {
      workspaceId,
      postId,
      revisionId,
      accountId,
      receiptId: receipt.id,
      actor: { type: 'user', id: userId },
    });
    expect(verified).toMatchObject({
      mediaSha256: mediaHash,
      caption: 'Exact caption',
      options: { aiGenerated: false, privacyLevel: 'SELF_ONLY' },
    });
    expect(verified).not.toHaveProperty('credential');
    expect(JSON.stringify(verified).length).toBeLessThan(1024);
    const audits = await pg.query<{ action: string; actor_id: string }>(
      `select action, actor_id from audit_events where target_id = '${receipt.id}'`,
    );
    expect(audits.rows).toEqual([{ action: 'publication.consent', actor_id: userId }]);
    await expect(
      pg.exec(`update publication_consents set payload_hash = '${'b'.repeat(64)}'
        where id = '${receipt.id}'`),
    ).rejects.toThrow();
    for (const type of ['api-key', 'delegated'] as const) {
      expect(
        (
          await verifyTikTokPublicationConsent(db, {
            workspaceId,
            postId,
            revisionId,
            accountId,
            receiptId: receipt.id,
            actor: { type, id: machineId },
          })
        ).mediaSha256,
      ).toBe(mediaHash);
    }
    await expect(
      verifyTikTokPublicationConsent(db, {
        workspaceId,
        postId,
        revisionId,
        accountId,
        receiptId: '00000000-0000-4000-8000-000000000999',
        actor: { type: 'api-key', id: machineId },
      }),
    ).rejects.toThrow('invalid');
    await expect(
      verifyTikTokPublicationConsent(db, {
        workspaceId,
        postId,
        revisionId,
        accountId: '00000000-0000-4000-8000-000000000999',
        receiptId: receipt.id,
        actor: { type: 'api-key', id: machineId },
      }),
    ).rejects.toThrow('invalid');
    await expect(
      verifyTikTokPublicationConsent(db, {
        workspaceId: otherWorkspaceId,
        postId,
        revisionId,
        accountId,
        receiptId: receipt.id,
        actor: { type: 'user', id: userId },
      }),
    ).rejects.toThrow('invalid');
  });

  it('reads receipt metadata only for the consenting human in its workspace and rejects revision drift', async () => {
    const receipt = await issueTikTokPublicationConsent(db, command());
    const readable = await getTikTokPublicationConsent(db, {
      workspaceId,
      userId,
      receiptId: receipt.id,
    });
    expect(readable).toEqual({
      id: receipt.id,
      postId,
      revisionId,
      accountId,
      payloadHash: receipt.payloadHash,
      consentedAt: receipt.consentedAt,
    });
    expect(JSON.stringify(readable)).not.toContain(mediaHash);
    for (const input of [
      { workspaceId: otherWorkspaceId, userId, receiptId: receipt.id },
      { workspaceId, userId: machineId, receiptId: receipt.id },
    ])
      await expect(getTikTokPublicationConsent(db, input)).rejects.toThrow('not found');
    await pg.exec(`insert into post_revisions (workspace_id, post_id, revision_number, content)
      values ('${workspaceId}', '${postId}', 2, '${content()}')`);
    await expect(
      getTikTokPublicationConsent(db, { workspaceId, userId, receiptId: receipt.id }),
    ).rejects.toThrow('invalid');
  });

  it('keeps machine post commands fail-closed even with a real or forged receipt ID', async () => {
    const receipt = await issueTikTokPublicationConsent(db, command());
    for (const receiptId of [receipt.id, '00000000-0000-4000-8000-000000000999']) {
      await expect(
        createPost(db, {
          workspaceId,
          userId,
          actor: { type: 'api-key', id: userId },
          selectedDestination: 'tiktok',
          providerAccountIds: [accountId],
          mediaIds: [mediaId],
          scheduledAt: new Date(Date.now() + 60_000),
          content: {
            schemaVersion: 1,
            kind: 'video',
            caption: 'Exact caption',
            mediaId,
            options: command().options,
            consentReceiptId: receiptId,
          },
        }),
      ).rejects.toThrow('TikTok publishing is not available');
    }
  });

  it.each([
    [
      'revision',
      `insert into post_revisions (workspace_id, post_id, revision_number, content)
      values ('${workspaceId}', '${postId}', 2, '${content()}')`,
    ],
    ['media hash', `update media_objects set sha256 = '${'b'.repeat(64)}' where id = '${mediaId}'`],
    ['rotation', `update credentials set version = 2 where id = '${credentialId}'`],
    ['revoke', `update provider_connections set revoked_at = now() where id = '${connectionId}'`],
    [
      'destination',
      `update provider_accounts set remote_account_id = 'different' where id = '${accountId}'`,
    ],
    [
      'membership',
      `delete from memberships where workspace_id = '${workspaceId}' and user_id = '${userId}'`,
    ],
  ])('invalidates after %s changes', async (_name, mutation) => {
    const receipt = await issueTikTokPublicationConsent(db, command());
    await pg.exec(mutation);
    await expect(
      verifyTikTokPublicationConsent(db, {
        workspaceId,
        postId,
        revisionId,
        accountId,
        receiptId: receipt.id,
        actor: { type: 'user', id: userId },
      }),
    ).rejects.toThrow('invalid');
  });

  it('rejects stale choices, disabled interactions, missing declarations and mismatched revision options', async () => {
    await expect(
      issueTikTokPublicationConsent(db, {
        ...command(),
        options: { ...command().options, allowDuet: true },
      }),
    ).rejects.toThrow('invalid');
    await expect(
      issueTikTokPublicationConsent(db, {
        ...command(),
        musicUsageConfirmed: false as true,
      }),
    ).rejects.toThrow();
    await pg.exec(`update provider_capability_snapshots set expires_at = now() - interval '1 second'
      where id = '${snapshotId}'`);
    await expect(issueTikTokPublicationConsent(db, command())).rejects.toThrow('invalid');
  });

  it('enforces commercial privacy and explicit AI choice', async () => {
    const brandedRevisionId = '00000000-0000-4000-8000-000000000303';
    const branded = {
      ...command(),
      options: {
        ...command().options,
        commercialContent: 'branded' as const,
        privacyLevel: 'PUBLIC_TO_EVERYONE' as const,
        aiGenerated: true,
      },
      brandedContentPolicyConfirmed: true,
      revisionId: brandedRevisionId,
    };
    await pg.exec(`insert into post_revisions (id, workspace_id, post_id, revision_number, content)
      values ('${brandedRevisionId}', '${workspaceId}', '${postId}', 2, '${content(branded)}');
      insert into revision_media (workspace_id, revision_id, media_id, position)
      values ('${workspaceId}', '${brandedRevisionId}', '${mediaId}', 0);`);
    const receipt = await issueTikTokPublicationConsent(db, branded);
    expect(
      (
        await verifyTikTokPublicationConsent(db, {
          workspaceId,
          postId,
          revisionId: brandedRevisionId,
          accountId,
          receiptId: receipt.id,
          actor: { type: 'user', id: userId },
        })
      ).options.aiGenerated,
    ).toBe(true);
    await expect(
      issueTikTokPublicationConsent(db, {
        ...branded,
        options: { ...branded.options, privacyLevel: 'SELF_ONLY' },
      }),
    ).rejects.toThrow('invalid');
    await expect(
      issueTikTokPublicationConsent(db, {
        ...branded,
        brandedContentPolicyConfirmed: false,
      }),
    ).rejects.toThrow('invalid');
    const friendsRevisionId = '00000000-0000-4000-8000-000000000304';
    const friends = {
      ...branded,
      revisionId: friendsRevisionId,
      options: { ...branded.options, privacyLevel: 'MUTUAL_FOLLOW_FRIENDS' as const },
    };
    await pg.exec(`insert into post_revisions (id, workspace_id, post_id, revision_number, content)
      values ('${friendsRevisionId}', '${workspaceId}', '${postId}', 3, '${content(friends)}');
      insert into revision_media (workspace_id, revision_id, media_id, position)
      values ('${workspaceId}', '${friendsRevisionId}', '${mediaId}', 0);`);
    const friendsReceipt = await issueTikTokPublicationConsent(db, friends);
    expect(
      (
        await verifyTikTokPublicationConsent(db, {
          workspaceId,
          postId,
          revisionId: friendsRevisionId,
          accountId,
          receiptId: friendsReceipt.id,
          actor: { type: 'user', id: userId },
        })
      ).options.privacyLevel,
    ).toBe('MUTUAL_FOLLOW_FRIENDS');
    await expect(
      verifyTikTokPublicationConsent(db, {
        workspaceId,
        postId,
        revisionId: brandedRevisionId,
        accountId,
        receiptId: receipt.id,
        actor: { type: 'user', id: userId },
      }),
    ).rejects.toThrow('invalid');
  });
});
