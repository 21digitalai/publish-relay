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
  type TikTokConsentCommand,
} from '../src/modules/providers/tiktok-consent.service.js';
import { createPost } from '../src/modules/content/post.service.js';
import { registerTikTokConsentRoutes } from '../src/modules/providers/tiktok-consent.routes.js';
import type { AuthService } from '../src/modules/identity/auth.service.js';

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
  '0019_media_retention_lifecycle',
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
      'subject-one', 1, 'One', '["SELF_ONLY", "PUBLIC_TO_EVERYONE"]',
      false, true, true, 120, now() - interval '1 minute', now() + interval '14 minutes');
  `);
});
afterEach(async () => pg.close());

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
  });
});
