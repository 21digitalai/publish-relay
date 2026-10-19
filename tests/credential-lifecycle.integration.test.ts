import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import {
  createCredential,
  getActiveCredential,
  revokeCredential,
  rotateCredential,
} from '../src/modules/credentials/credential.repository.js';
import type {
  EncryptedCredential,
  MasterKeyProvider,
} from '../src/modules/credentials/envelope.js';
import { decryptCredential } from '../src/modules/credentials/envelope.js';
import { FakeProviderConnectionAdapter } from '../src/modules/credentials/provider-adapter.js';
import { connectProvider } from '../src/modules/credentials/provider-connection.service.js';
import {
  disconnectProviderSubject,
  rotateProviderSubjectCredential,
} from '../src/modules/credentials/provider-subject.service.js';
import {
  markProviderDestinationsUnavailable,
  ProviderDestinationConflictError,
} from '../src/modules/credentials/provider-connection.repository.js';
import {
  disconnectProviderAccount,
  listProviderAccounts,
  updateYouTubeAccountDefaults,
  updateXLongPostDeclaration,
} from '../src/modules/credentials/provider-account.service.js';
import {
  cleanupExpiredOauthTransactions,
  consumeOauthCallback,
  hashOauthState,
  issueOauthTransaction,
} from '../src/modules/credentials/oauth.service.js';
import { XHttpClient } from '../src/modules/providers/x-http-client.js';
import {
  beginXOauthConnection,
  completeXOauthConnection,
} from '../src/modules/providers/x-oauth.service.js';
import type { ActionPolicy } from '../src/modules/policy/action-policy.js';
import { completeYouTubeOauthConnection } from '../src/modules/providers/youtube-oauth.service.js';
import {
  beginLinkedInConnection,
  completeLinkedInConnection,
  LinkedInMemberMismatchError,
} from '../src/modules/providers/linkedin-oauth.service.js';
import type { LinkedInHttpClient } from '../src/modules/providers/linkedin-http-client.js';
import {
  completeMetaOauthConnection,
  MetaNoUsableDestinationsError,
} from '../src/modules/providers/meta-oauth.service.js';
import type { MetaFamilyCallbackError } from '../src/modules/providers/meta-oauth.service.js';
import { MetaRequestError } from '../src/modules/providers/meta-http-client.js';
import { completeInstagramLogin } from '../src/modules/providers/instagram-login.service.js';
import { getFreshInstagramLoginToken } from '../src/modules/providers/instagram-login-credential.service.js';
import { promoteInstagramLoginAccount } from '../src/modules/providers/instagram-login-promotion.service.js';
import {
  beginTikTokOauthConnection,
  completeTikTokOauthConnection,
} from '../src/modules/providers/tiktok-oauth.service.js';
import { getFreshTikTokToken } from '../src/modules/providers/tiktok-credential.service.js';
import { registerDestinationRoutes } from '../src/modules/credentials/destination.routes.js';
import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import { apiV1OpenApiDocument } from '../src/modules/api/openapi.js';
import {
  ApiKeyAuthorizationError,
  type ApiKeyService,
} from '../src/modules/identity/api-key.service.js';

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
  '0016_common_barracuda.sql',
  '0025_lucky_legion.sql',
  '0028_nosy_dracula.sql',
  '0042_long_pepper_potts.sql',
  '0019_media_retention_lifecycle.sql',
  '0045_meta_destination_foundation.sql',
  '0046_linkedin_connection_expiry.sql',
  '0047_linkedin_member_connections.sql',
  '0048_reconcile_linkedin_connections.sql',
  '0049_meta_effective_payload.sql',
  '0051_provider_subject_lifecycle.sql',
  '0055_x_long_post_declaration.sql',
  '0056_meta_grant_family.sql',
  '0057_instagram_login_legacy_grants.sql',
  '0058_workspace_tombstone.sql',
  '0059_provider_account_exposures.sql',
  '0061_cross_workspace_account_job_guard.sql',
  '0065_paginated_exposed_facebook_pages.sql',
  '0075_machine_exposed_page_discovery.sql',
  '0077_publication_attempt_external_url.sql',
];
const workspaceId = '00000000-0000-4000-8000-000000000101';
const userId = '00000000-0000-4000-8000-000000000102';
let database: PGlite;

function oauthState(url: string): string {
  const state = new URL(url).searchParams.get('state');
  if (!state) throw new Error('OAuth state missing from fixture URL');
  return state;
}

function encrypted(marker: number): EncryptedCredential {
  const bytes = (value: number) => Buffer.from([value]);
  return {
    keyVersion: `v${String(marker)}`,
    wrappedKey: bytes(marker),
    wrappedKeyNonce: bytes(2),
    wrappedKeyTag: bytes(3),
    ciphertext: bytes(4),
    nonce: bytes(5),
    tag: bytes(6),
  };
}

beforeEach(async () => {
  database = new PGlite();
  for (const migration of migrations)
    await database.exec(
      await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'),
    );
  await database.exec(`
    INSERT INTO workspaces (id, name, slug) VALUES ('${workspaceId}', 'Credential Workspace', 'credential-workspace');
    INSERT INTO users (id, email, password_hash) VALUES ('${userId}', 'credential@example.test', 'redacted');
    SELECT set_config('app.workspace_id', '${workspaceId}', false);
    INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${workspaceId}', '${userId}', 'owner');
  `);
});

it('serves bounded Meta destination variants and a live LinkedIn destination through the machine route', async () => {
  const db = drizzle(database) as unknown as NodePgDatabase;
  const instagramId = '00000000-0000-4000-8000-000000000601';
  const facebookId = '00000000-0000-4000-8000-000000000602';
  const linkedInId = '00000000-0000-4000-8000-000000000603';
  await database.exec(`
    INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
      VALUES ('00000000-0000-4000-8000-000000000604', '${workspaceId}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
    INSERT INTO provider_connections (id, workspace_id, provider, credential_id, member_urn) VALUES
      ('00000000-0000-4000-8000-000000000605', '${workspaceId}', 'meta', '00000000-0000-4000-8000-000000000604', null),
      ('00000000-0000-4000-8000-000000000606', '${workspaceId}', 'linkedin', '00000000-0000-4000-8000-000000000604', 'urn:li:person:mira');
    INSERT INTO provider_accounts
      (id, workspace_id, connection_id, provider_account_id, remote_account_id, display_name,
       destination_provider, remote_parent_account_id, availability, capabilities_checked_at) VALUES
      ('${instagramId}', '${workspaceId}', '00000000-0000-4000-8000-000000000605',
       'ig', 'ig', '@mira', 'instagram', 'page-one', 'active', now()),
      ('${facebookId}', '${workspaceId}', '00000000-0000-4000-8000-000000000605',
       'page-one', 'page-one', 'Mira Studio', 'facebook_page', null, 'remote_missing', now() - interval '2 days'),
      ('${linkedInId}', '${workspaceId}', '00000000-0000-4000-8000-000000000606',
       'member-one', 'member-one', 'Mira LinkedIn', 'linkedin', null, 'active', now());
  `);
  const principal = {
    id: '00000000-0000-4000-8000-000000000607',
    workspaceId,
    createdByUserId: userId,
    workspaceLabel: 'Credential Workspace',
    prefix: 'pr_test',
    capabilities: ['destinations:read'],
    expiresAt: null,
  };
  const keys = {
    authenticate: () => Promise.resolve(principal),
    requireCapability: () => Promise.resolve(),
  } as unknown as ApiKeyService;
  const application = Fastify();
  registerDestinationRoutes(
    application,
    db,
    keys,
    new ApiRateLimiter({
      workspace: 10,
      key: 10,
      mutationWorkspace: 10,
      mutationKey: 10,
      windowMs: 60_000,
    }),
  );
  const response = await application.inject({
    method: 'GET',
    url: '/api/v1/destinations',
    headers: {
      authorization: 'Bearer test-key',
      'x-publish-relay-workspace': workspaceId,
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ data: { items: Record<string, unknown>[] } }>();
  expect(body.data.items).toHaveLength(3);
  expect(body.data.items.find((item) => item.id === instagramId)).toMatchObject({
    provider: 'meta',
    destinationProvider: 'instagram',
    availability: 'active',
    remoteParentAccountId: 'page-one',
    capabilityFreshness: 'fresh',
  });
  expect(body.data.items.find((item) => item.id === facebookId)).toMatchObject({
    provider: 'meta',
    destinationProvider: 'facebook_page',
    availability: 'remote_missing',
    capabilityFreshness: 'stale',
  });
  expect(body.data.items.find((item) => item.id === linkedInId)).toMatchObject({
    provider: 'linkedin',
    destinationProvider: 'linkedin',
    availability: 'active',
  });
  expect(JSON.stringify(body)).not.toMatch(/credentialId|connectionId|adapterDefaults|secret/i);
  for (const availability of ['reauth_required', 'permission_lost', 'remote_missing', 'active']) {
    await database.exec(
      `UPDATE provider_accounts SET availability = '${availability}' WHERE id = '${facebookId}'`,
    );
    const variant = await application.inject({
      method: 'GET',
      url: '/api/v1/destinations',
      headers: {
        authorization: 'Bearer test-key',
        'x-publish-relay-workspace': workspaceId,
      },
    });
    expect(variant.statusCode).toBe(200);
    const items = variant.json<{ data: { items: Record<string, unknown>[] } }>().data.items;
    expect(items.find((item) => item.id === facebookId)).toMatchObject({ availability });
    expect(items.find((item) => item.id === instagramId)).toMatchObject({ availability: 'active' });
  }
  const paths = apiV1OpenApiDocument().paths as Record<string, unknown>;
  expect(JSON.stringify(paths['/api/v1/destinations'])).toContain('linkedin');
  await application.close();
});

afterEach(async () => database.close());

describe('credential and OAuth persistence', () => {
  it.each(['x', 'youtube', 'meta'])(
    'keeps two %s grant principals isolated and refuses overlapping destinations',
    async (provider) => {
      const db = drizzle(database) as unknown as NodePgDatabase;
      const keys: MasterKeyProvider = {
        currentVersion: () => 'v1',
        getKey: () => Promise.resolve(Buffer.alloc(32, 7)),
      };
      const destinationProvider =
        provider === 'meta' ? ('facebook_page' as const) : (provider as 'x' | 'youtube');
      const connect = (subject: string, destination: string, token: string) =>
        connectProvider(
          db,
          keys,
          new FakeProviderConnectionAdapter([
            {
              providerAccountId: destination,
              remoteAccountId: destination,
              destinationProvider,
              displayName: destination,
            },
          ]),
          {
            workspaceId,
            userId,
            provider,
            externalSubjectId: subject,
            accessToken: token,
            requestId: `connect-${subject}`,
          },
        );
      const first = await connect('principal-one', 'destination-one', 'token-one');
      const sibling = await connect('principal-two', 'destination-two', 'token-two');
      expect(first.connectionId).not.toBe(sibling.connectionId);
      expect((await connect('principal-one', 'destination-one', 'replacement')).connectionId).toBe(
        first.connectionId,
      );
      await expect(connect('principal-three', 'destination-two', 'conflict')).rejects.toThrow(
        'manual resolution required',
      );
      const rows = await database.query<{ external_subject_id: string; ciphertext: Uint8Array }>(
        'SELECT pc.external_subject_id, c.ciphertext FROM provider_connections pc JOIN credentials c ON c.id = pc.credential_id ORDER BY pc.external_subject_id',
      );
      expect(rows.rows.map((row) => row.external_subject_id)).toEqual([
        'principal-one',
        'principal-two',
      ]);
      const siblingRow = rows.rows[1];
      if (!siblingRow) throw new Error('Expected sibling connection');
      const priorCiphertext = Buffer.from(siblingRow.ciphertext).toString('hex');
      await database.exec(
        `UPDATE provider_connections SET external_subject_id = 'legacy:${sibling.connectionId}' WHERE id = '${sibling.connectionId}'`,
      );
      await expect(connect('principal-two', 'destination-two', 'new-grant')).rejects.toThrow(
        'manual resolution required',
      );
      const retained = await database.query<{ ciphertext: Uint8Array }>(
        `SELECT c.ciphertext FROM provider_connections pc JOIN credentials c ON c.id = pc.credential_id WHERE pc.id = '${sibling.connectionId}'`,
      );
      const retainedRow = retained.rows[0];
      if (!retainedRow) throw new Error('Expected retained sibling credential');
      expect(Buffer.from(retainedRow.ciphertext).toString('hex')).toBe(priorCiphertext);
    },
  );

  it('keeps two subject-keyed connections independent through reconnect', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(Buffer.alloc(32, 7)),
    };
    const connect = (subject: string, token: string) =>
      connectProvider(
        db,
        keys,
        new FakeProviderConnectionAdapter([{ providerAccountId: subject, displayName: subject }]),
        {
          workspaceId,
          userId,
          provider: 'tiktok',
          externalSubjectId: subject,
          accessToken: token,
          requestId: `req-${subject}-${token}`,
        },
      );
    const first = await connect('subject-one', 'first-token');
    const second = await connect('subject-two', 'second-token');
    expect(first.connectionId).not.toBe(second.connectionId);
    const siblingBefore = await database.query<{ credential_id: string }>(
      "SELECT credential_id FROM provider_connections WHERE external_subject_id = 'subject-two'",
    );
    const reconnect = await connect('subject-one', 'replacement-token');
    expect(reconnect.connectionId).toBe(first.connectionId);
    const siblingAfter = await database.query<{ credential_id: string; status: string }>(
      "SELECT credential_id, status FROM provider_connections WHERE external_subject_id = 'subject-two'",
    );
    expect(siblingAfter.rows[0]).toEqual({
      credential_id: siblingBefore.rows[0]?.credential_id,
      status: 'active',
    });
    const accounts = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM provider_accounts WHERE destination_provider = 'tiktok'",
    );
    expect(accounts.rows[0]?.count).toBe('2');
    expect(
      await rotateProviderSubjectCredential(db, {
        workspaceId: '00000000-0000-4000-8000-000000000999',
        provider: 'tiktok',
        externalSubjectId: 'subject-one',
        expectedVersion: 1,
        encrypted: encrypted(8),
        scopes: [],
        accessExpiresAt: new Date('2026-11-01T10:00:00Z'),
        refreshExpiresAt: null,
        requestId: 'foreign-refresh',
      }),
    ).toBe(false);
    const rotated = await rotateProviderSubjectCredential(db, {
      workspaceId,
      provider: 'tiktok',
      externalSubjectId: 'subject-one',
      expectedVersion: 1,
      encrypted: encrypted(9),
      scopes: ['video.publish'],
      accessExpiresAt: new Date('2026-11-01T10:00:00Z'),
      refreshExpiresAt: new Date('2026-12-01T10:00:00Z'),
      requestId: 'refresh-one',
    });
    expect(rotated).toBe(true);
    expect(
      await rotateProviderSubjectCredential(db, {
        workspaceId,
        provider: 'tiktok',
        externalSubjectId: 'subject-one',
        expectedVersion: 1,
        encrypted: encrypted(10),
        scopes: [],
        accessExpiresAt: new Date('2026-11-02T10:00:00Z'),
        refreshExpiresAt: null,
        requestId: 'stale-refresh',
      }),
    ).toBe(false);
    const firstAccount = await database.query<{ id: string }>(
      "SELECT id FROM provider_accounts WHERE provider_account_id = 'subject-one'",
    );
    const post = await database.query<{ id: string }>(
      `INSERT INTO posts (workspace_id, created_by_user_id) VALUES ($1, $2) RETURNING id`,
      [workspaceId, userId],
    );
    const revision = await database.query<{ id: string }>(
      `INSERT INTO post_revisions (workspace_id, post_id, revision_number, content)
         VALUES ($1, $2, 1, '{}') RETURNING id`,
      [workspaceId, post.rows[0]?.id],
    );
    await database.query(
      `INSERT INTO publication_jobs
           (workspace_id, post_id, revision_id, provider_account_id, scheduled_at, state)
         VALUES ($1, $2, $3, $4, now(), 'accepted_pending')`,
      [workspaceId, post.rows[0]?.id, revision.rows[0]?.id, firstAccount.rows[0]?.id],
    );
    await expect(
      disconnectProviderSubject(db, {
        workspaceId,
        userId,
        provider: 'tiktok',
        externalSubjectId: 'subject-one',
        requestId: 'disconnect-pending',
      }),
    ).rejects.toThrow('Scheduled publications must be resolved before disconnect');
    await database.query(
      "UPDATE publication_jobs SET state = 'failed', reconciliation_required = true WHERE state = 'accepted_pending'",
    );
    await expect(
      disconnectProviderSubject(db, {
        workspaceId,
        userId,
        provider: 'tiktok',
        externalSubjectId: 'subject-one',
        requestId: 'disconnect-unresolved',
      }),
    ).rejects.toThrow('Scheduled publications must be resolved before disconnect');
    await database.query('UPDATE publication_jobs SET reconciliation_required = false');
    const disconnected = await disconnectProviderSubject(db, {
      workspaceId,
      userId,
      provider: 'tiktok',
      externalSubjectId: 'subject-one',
      requestId: 'disconnect-one',
    });
    expect(disconnected).toBe(true);
    const states = await database.query<{
      external_subject_id: string;
      status: string;
      revoked_at: Date | null;
      version: number;
    }>(`SELECT connection.external_subject_id, connection.status, credential.revoked_at,
         credential.version FROM provider_connections connection
         JOIN credentials credential ON credential.id = connection.credential_id
         WHERE connection.provider = 'tiktok' ORDER BY connection.external_subject_id`);
    expect(states.rows).toMatchObject([
      { external_subject_id: 'subject-one', status: 'revoked', version: 2 },
      { external_subject_id: 'subject-two', status: 'active', revoked_at: null, version: 1 },
    ]);
    expect(states.rows[0]?.revoked_at).not.toBeNull();
  });

  it('integrates TikTok callback state, verified subjects, reconnect and legacy conflict atomically', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(Buffer.alloc(32, 7)),
    };
    let subject = 'open-one';
    let serial = 0;
    const client = {
      authorizationUrl: (input: { state: string }) =>
        `https://www.tiktok.com/v2/auth/authorize/?state=${input.state}`,
      exchangeCode: () =>
        Promise.resolve({
          access_token: `access-${String(++serial)}`,
          refresh_token: `refresh-${String(serial)}`,
          open_id: subject,
          scope: 'user.info.basic,video.publish',
          token_type: 'Bearer' as const,
          expires_in: 3600,
          refresh_expires_in: 86400,
        }),
      discoverAccount: () =>
        Promise.resolve({ openId: subject, displayName: `Creator ${subject}` }),
      refresh: () =>
        Promise.resolve({
          access_token: 'rotated-access',
          refresh_token: 'rotated-refresh',
          open_id: 'open-one',
          scope: 'user.info.basic,video.publish',
          token_type: 'Bearer' as const,
          expires_in: 3600,
          refresh_expires_in: 86400,
        }),
    };
    const begin = () =>
      beginTikTokOauthConnection(db, keys, client as never, {
        workspaceId,
        userId,
        callbackUrl: 'https://relay.test/api/oauth/tiktok/callback',
        requestId: 'start',
      });
    const callback = (state: string) =>
      completeTikTokOauthConnection(db, keys, client as never, {
        workspaceId,
        userId,
        state,
        code: `code-${String(serial)}`,
        requestId: 'callback',
      });
    const stateOne = oauthState((await begin()).authorizationUrl);
    expect(await callback('wrong-state')).toBeNull();
    const first = await callback(stateOne);
    expect(first?.accounts).toEqual([
      { providerAccountId: 'open-one', displayName: 'Creator open-one' },
    ]);
    expect(await callback(stateOne)).toBeNull();
    const expiredState = oauthState((await begin()).authorizationUrl);
    await database.query('UPDATE oauth_transactions SET expires_at = $1 WHERE state_hash = $2', [
      new Date('2026-09-01T00:00:00Z'),
      hashOauthState(expiredState),
    ]);
    expect(await callback(expiredState)).toBeNull();
    subject = 'open-two';
    const stateTwo = oauthState((await begin()).authorizationUrl);
    const second = await callback(stateTwo);
    expect(second?.connectionId).not.toBe(first?.connectionId);
    expect(
      (await listProviderAccounts(db, workspaceId)).filter(
        (account) => account.provider === 'tiktok',
      ),
    ).toHaveLength(2);
    await database.query(
      "UPDATE provider_connections SET access_expires_at = '2026-09-30T00:00:00Z' WHERE external_subject_id = 'open-one'",
    );
    expect(
      (await listProviderAccounts(db, workspaceId)).find(
        (account) => account.displayName === 'Creator open-one',
      )?.status,
    ).toBe('expired');
    await database.query(
      "UPDATE provider_connections SET refresh_expires_at = '2026-09-30T00:00:00Z' WHERE external_subject_id = 'open-one'",
    );
    expect(
      (await listProviderAccounts(db, workspaceId)).find(
        (account) => account.displayName === 'Creator open-one',
      )?.status,
    ).toBe('renewal_required');
    await database.query(
      "UPDATE provider_connections SET refresh_expires_at = '2026-12-01T00:00:00Z' WHERE external_subject_id = 'open-one'",
    );
    const refreshed = await getFreshTikTokToken(db, keys, client as never, {
      workspaceId,
      openId: 'open-one',
      requestId: 'refresh',
      now: new Date('2026-10-01T00:00:00Z'),
    });
    expect(refreshed.refresh_token).toBe('rotated-refresh');
    const versions = await database.query<{ external_subject_id: string; version: number }>(
      "SELECT pc.external_subject_id, c.version FROM provider_connections pc JOIN credentials c ON c.id = pc.credential_id WHERE pc.provider = 'tiktok' ORDER BY pc.external_subject_id",
    );
    expect(versions.rows).toEqual([
      { external_subject_id: 'open-one', version: 2 },
      { external_subject_id: 'open-two', version: 1 },
    ]);
    const beforeReconnect = await database.query<{
      external_subject_id: string;
      credential_id: string;
    }>(
      "SELECT external_subject_id, credential_id FROM provider_connections WHERE provider = 'tiktok' ORDER BY external_subject_id",
    );
    subject = 'open-one';
    const stateReconnect = oauthState((await begin()).authorizationUrl);
    expect((await callback(stateReconnect))?.connectionId).toBe(first?.connectionId);
    const before = await database.query<{ external_subject_id: string; credential_id: string }>(
      "SELECT external_subject_id, credential_id FROM provider_connections WHERE provider = 'tiktok' ORDER BY external_subject_id",
    );
    expect(before.rows).toHaveLength(2);
    expect(before.rows[0]?.credential_id).not.toBe(beforeReconnect.rows[0]?.credential_id);
    expect(before.rows[1]?.credential_id).toBe(beforeReconnect.rows[1]?.credential_id);
    const rotatedToken = await withTenantTransaction(db, { workspaceId }, async (transaction) => {
      const credential = await getActiveCredential(
        transaction,
        workspaceId,
        before.rows[0]?.credential_id ?? '',
      );
      if (!credential) throw new Error('TikTok reconnect credential missing');
      const plaintext = await decryptCredential(credential, keys);
      try {
        return JSON.parse(plaintext.toString('utf8')) as {
          access_token: string;
          refresh_token: string;
        };
      } finally {
        plaintext.fill(0);
      }
    });
    expect(rotatedToken).toMatchObject({ access_token: 'access-3', refresh_token: 'refresh-3' });
    await database.query(
      "UPDATE provider_connections SET external_subject_id = 'legacy:old-grant' WHERE external_subject_id = 'open-two'",
    );
    subject = 'open-two';
    const stateConflict = oauthState((await begin()).authorizationUrl);
    await expect(callback(stateConflict)).rejects.toThrow('manual resolution required');
    const after = await database.query<{ external_subject_id: string; credential_id: string }>(
      "SELECT external_subject_id, credential_id FROM provider_connections WHERE provider = 'tiktok' ORDER BY external_subject_id",
    );
    expect(after.rows).toEqual([
      { external_subject_id: 'legacy:old-grant', credential_id: before.rows[1]?.credential_id },
      before.rows[0],
    ]);
    await database.query(
      "UPDATE provider_accounts SET disconnected_at = now() WHERE provider_account_id = 'open-two'",
    );
    expect(
      (await listProviderAccounts(db, workspaceId)).find(
        (account) => account.displayName === 'Creator open-two',
      )?.status,
    ).toBe('disconnected');
  });

  it('connects two LinkedIn members and reconnects only the matching identity', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const key = Buffer.alloc(32, 7);
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(key),
    };
    const connect = (member: string, token: string, label: string) =>
      connectProvider(
        db,
        keys,
        new FakeProviderConnectionAdapter([
          { providerAccountId: `urn:li:person:${member}`, displayName: label },
        ]),
        {
          workspaceId,
          userId,
          provider: 'linkedin',
          accessToken: token,
          requestId: `req-${member}-${token}`,
        },
      );
    const first = await connect('member-1', 'first-token', 'Member One');
    const second = await connect('member-2', 'second-token', 'Member Two');
    const before = await listProviderAccounts(db, workspaceId);
    expect(before).toHaveLength(2);
    expect(before.map((account) => account.displayName).sort()).toEqual([
      'Member One',
      'Member Two',
    ]);
    expect(first.connectionId).not.toBe(second.connectionId);
    const priorCredentials = await database.query<{
      id: string;
      member_urn: string;
      revoked_at: Date | null;
    }>(`
      SELECT credential.id, connection.member_urn, credential.revoked_at
      FROM provider_connections connection
      JOIN credentials credential ON credential.id = connection.credential_id
      WHERE connection.workspace_id = '${workspaceId}' AND connection.provider = 'linkedin'
    `);
    const secondCredential = priorCredentials.rows.find(
      (row) => row.member_urn === 'urn:li:person:member-2',
    );

    const reconnect = await connect('member-1', 'new-first-token', 'Member One Updated');
    const after = await listProviderAccounts(db, workspaceId);
    expect(reconnect.connectionId).toBe(first.connectionId);
    expect(after).toHaveLength(2);
    expect(after.find((account) => account.displayName === 'Member Two')).toEqual(
      before.find((account) => account.displayName === 'Member Two'),
    );
    expect(after.some((account) => account.displayName === 'Member One Updated')).toBe(true);
    const currentCredentials = await database.query<{
      id: string;
      member_urn: string;
      revoked_at: Date | null;
    }>(`
      SELECT credential.id, connection.member_urn, credential.revoked_at
      FROM provider_connections connection
      JOIN credentials credential ON credential.id = connection.credential_id
      WHERE connection.workspace_id = '${workspaceId}' AND connection.provider = 'linkedin'
    `);
    expect(
      currentCredentials.rows.find((row) => row.member_urn === 'urn:li:person:member-2'),
    ).toEqual(secondCredential);
  });

  it('binds LinkedIn reconnect to selected member across OAuth and preserves both accounts on mismatch', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const key = Buffer.alloc(32, 7);
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(key),
    };
    for (const member of ['member-1', 'member-2'])
      await connectProvider(
        db,
        keys,
        new FakeProviderConnectionAdapter([
          { providerAccountId: `urn:li:person:${member}`, displayName: member },
        ]),
        {
          workspaceId,
          userId,
          provider: 'linkedin',
          accessToken: `original-${member}`,
          requestId: member,
        },
      );
    const accounts = await listProviderAccounts(db, workspaceId);
    const selected = accounts.find((account) => account.displayName === 'member-2');
    expect(selected).toBeDefined();
    const before = await database.query<{ member_urn: string; credential_id: string }>(
      "select member_urn, credential_id from provider_connections where provider = 'linkedin' order by member_urn",
    );
    const client = {
      authorizationUrl: ({ state }: { state: string }) =>
        `https://linkedin.example/authorize?state=${state}`,
      exchangeCode: ({ code }: { code: string }) =>
        Promise.resolve({
          accessToken: `new-${code}`,
          memberUrn: `urn:li:person:${code}`,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          scope: 'w_member_social',
        }),
      discoverMember: (token: string) =>
        Promise.resolve({
          memberUrn: `urn:li:person:${token.replace('new-', '')}`,
          displayName: token.replace('new-', ''),
        }),
    } as unknown as LinkedInHttpClient;
    if (!selected) throw new Error('Member Two account fixture is missing');
    await expect(
      beginLinkedInConnection(db, keys, client, {
        workspaceId,
        userId,
        callbackUrl: 'https://relay.example/callback',
        requestId: 'missing-account',
        accountId: '00000000-0000-4000-8000-000000000999',
      }),
    ).rejects.toThrow('selected LinkedIn account is no longer available');
    const begin = async () => {
      const result = await beginLinkedInConnection(db, keys, client, {
        workspaceId,
        userId,
        callbackUrl: 'https://relay.example/callback',
        requestId: 'begin',
        accountId: selected.id,
      });
      const state = new URL(result.authorizationUrl).searchParams.get('state');
      if (!state) throw new Error('LinkedIn OAuth state was not issued');
      return state;
    };
    await expect(
      completeLinkedInConnection(db, keys, client, {
        workspaceId,
        userId,
        state: await begin(),
        code: 'member-1',
        requestId: 'wrong-member',
      }),
    ).rejects.toBeInstanceOf(LinkedInMemberMismatchError);
    expect(
      (
        await database.query(
          "select member_urn, credential_id from provider_connections where provider = 'linkedin' order by member_urn",
        )
      ).rows,
    ).toEqual(before.rows);
    await completeLinkedInConnection(db, keys, client, {
      workspaceId,
      userId,
      state: await begin(),
      code: 'member-2',
      requestId: 'correct-member',
    });
    const after = await database.query<{ member_urn: string; credential_id: string }>(
      "select member_urn, credential_id from provider_connections where provider = 'linkedin' order by member_urn",
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[1]?.credential_id).not.toBe(before.rows[1]?.credential_id);
    expect(await listProviderAccounts(db, workspaceId)).toHaveLength(2);
  });

  it('stores LinkedIn expiry as tenant-scoped connection metadata without exposing the credential', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const key = Buffer.alloc(32, 7);
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(key),
    };
    const expiresAt = new Date('2026-11-20T12:00:00.000Z');
    await connectProvider(
      db,
      keys,
      new FakeProviderConnectionAdapter([
        { providerAccountId: 'urn:li:person:member-1', displayName: 'Member One' },
      ]),
      {
        workspaceId,
        userId,
        provider: 'linkedin',
        accessToken: JSON.stringify({
          accessToken: 'private',
          expiresAt: expiresAt.toISOString(),
          memberUrn: 'urn:li:person:member-1',
        }),
        expiresAt,
        requestId: 'req-linkedin',
      },
    );
    const accounts = await listProviderAccounts(db, workspaceId);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      provider: 'linkedin',
      displayName: 'Member One',
      expiresAt,
    });
    expect(JSON.stringify(accounts)).not.toContain('private');
    expect(JSON.stringify(accounts)).not.toContain('credentialId');
  });

  it('rotates optimistically and revokes once without exposing plaintext fields', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const created = await withTenantTransaction(db, { workspaceId }, (tx) =>
      createCredential(tx, workspaceId, encrypted(1)),
    );
    expect(Object.keys(created)).not.toContain('plaintext');
    const [winner, loser] = await Promise.all([
      withTenantTransaction(db, { workspaceId }, (tx) =>
        rotateCredential(tx, workspaceId, created.id, 1, encrypted(2)),
      ),
      withTenantTransaction(db, { workspaceId }, (tx) =>
        rotateCredential(tx, workspaceId, created.id, 1, encrypted(3)),
      ),
    ]);
    expect([winner, loser].filter(Boolean)).toHaveLength(1);
    await expect(
      withTenantTransaction(db, { workspaceId }, (tx) =>
        revokeCredential(tx, workspaceId, created.id, new Date()),
      ),
    ).resolves.toBe(true);
    await expect(
      withTenantTransaction(db, { workspaceId }, (tx) =>
        revokeCredential(tx, workspaceId, created.id, new Date()),
      ),
    ).resolves.toBe(false);
  });

  it('consumes an unexpired OAuth state once and discovers multiple fake accounts', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const key = randomBytes(32);
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(key),
    };
    const issued = await issueOauthTransaction(db, keys, {
      workspaceId,
      userId,
      provider: 'fake',
      redirectUri: 'https://app.example.test/oauth/callback',
    });
    expect(issued.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    const persisted = await database.query<{ state_hash: string; redirect_uri: string }>(
      'select state_hash, redirect_uri from oauth_transactions',
    );
    expect(persisted.rows[0]?.state_hash).toBe(hashOauthState(issued.state));
    expect(JSON.stringify(persisted.rows[0])).not.toContain(issued.state);
    const attempts = await Promise.all([
      consumeOauthCallback(db, keys, { workspaceId, state: issued.state }),
      consumeOauthCallback(db, keys, { workspaceId, state: issued.state }),
    ]);
    const first = attempts.find(Boolean);
    expect(first?.provider).toBe('fake');
    expect(first?.redirectUri).toBe('https://app.example.test/oauth/callback');
    expect(
      createHash('sha256')
        .update(first?.codeVerifier ?? '')
        .digest('base64url'),
    ).toBe(issued.codeChallenge);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const secretCounts = await database.query<{ credentials: number; transactions: number }>(
      `select
        (select count(*)::int from credentials) as credentials,
        (select count(*)::int from oauth_transactions) as transactions`,
    );
    expect(secretCounts.rows[0]).toEqual({ credentials: 0, transactions: 0 });
    const adapter = new FakeProviderConnectionAdapter([
      { providerAccountId: 'one', displayName: 'One' },
      { providerAccountId: 'two', displayName: 'Two' },
    ]);
    await expect(adapter.discoverAccounts('never-persisted-token')).resolves.toHaveLength(2);
  });

  it('binds YouTube OAuth state and persists only encrypted credential and allowlisted accounts', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const key = randomBytes(32);
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(key),
    };
    const issued = await issueOauthTransaction(db, keys, {
      workspaceId,
      userId,
      provider: 'youtube',
      redirectUri: 'https://relay.test/youtube/callback',
    });
    await expect(
      consumeOauthCallback(db, keys, {
        workspaceId,
        state: issued.state,
        userId: '00000000-0000-4000-8000-000000000103',
        provider: 'youtube',
      }),
    ).resolves.toBeNull();
    await expect(
      consumeOauthCallback(db, keys, {
        workspaceId,
        state: issued.state,
        userId,
        provider: 'x',
      }),
    ).resolves.toBeNull();
    const credential = {
      accessToken: 'yt-access',
      refreshToken: 'yt-refresh',
      expiresAt: '2026-09-09T00:00:00.000Z',
      scope: 'youtube.upload',
    };
    let exchangeCalls = 0;
    const client = {
      exchangeCode: () => {
        exchangeCalls += 1;
        return Promise.resolve(credential);
      },
      discoverChannels: () =>
        Promise.resolve([{ id: 'channel-1', displayName: 'Channel One', privateField: 'discard' }]),
      discoverPrincipal: () => Promise.resolve('google-sub'),
    };
    const connected = await completeYouTubeOauthConnection(db, keys, client as never, {
      workspaceId,
      userId,
      state: issued.state,
      code: 'code',
      requestId: 'youtube-connect',
    });
    expect(connected?.accounts).toEqual([
      { providerAccountId: 'channel-1', displayName: 'Channel One' },
    ]);
    await expect(
      completeYouTubeOauthConnection(db, keys, client as never, {
        workspaceId,
        userId,
        state: issued.state,
        code: 'code',
        requestId: 'youtube-replay',
      }),
    ).resolves.toBeNull();
    expect(exchangeCalls).toBe(1);
    const connection = await database.query<{ credential_id: string }>(
      "select credential_id from provider_connections where provider = 'youtube'",
    );
    const credentialId = connection.rows[0]?.credential_id;
    if (!credentialId) throw new Error('Expected persisted YouTube credential');
    const stored = await withTenantTransaction(db, { workspaceId }, (tx) =>
      getActiveCredential(tx, workspaceId, credentialId),
    );
    expect(stored).not.toBeNull();
    if (!stored) throw new Error('Expected active YouTube credential');
    const plaintext = await decryptCredential(stored, keys);
    try {
      expect(JSON.parse(plaintext.toString('utf8'))).toEqual(credential);
    } finally {
      plaintext.fill(0);
    }
    const accounts = await database.query<{ provider_account_id: string; display_name: string }>(
      'select provider_account_id, display_name from provider_accounts',
    );
    expect(accounts.rows).toEqual([
      { provider_account_id: 'channel-1', display_name: 'Channel One' },
    ]);

    const expiredAt = new Date('2026-09-01T00:00:00.000Z');
    const expired = await issueOauthTransaction(db, keys, {
      workspaceId,
      userId,
      provider: 'youtube',
      redirectUri: 'https://relay.test/youtube/callback',
      now: expiredAt,
    });
    await expect(
      consumeOauthCallback(db, keys, {
        workspaceId,
        state: expired.state,
        userId,
        provider: 'youtube',
        now: new Date(expiredAt.getTime() + 11 * 60 * 1000),
      }),
    ).resolves.toBeNull();
    expect(exchangeCalls).toBe(1);
  });

  it('removes abandoned OAuth transactions and their encrypted verifiers after expiry', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(randomBytes(32)),
    };
    const now = new Date('2026-08-31T12:00:00.000Z');
    await issueOauthTransaction(db, keys, {
      workspaceId,
      userId,
      provider: 'fake',
      redirectUri: 'https://app.example.test/oauth/callback',
      now,
    });
    await expect(
      cleanupExpiredOauthTransactions(db, workspaceId, new Date(now.getTime() + 11 * 60 * 1000)),
    ).resolves.toBe(1);
    const counts = await database.query<{ credentials: number; transactions: number }>(
      `select
        (select count(*)::int from credentials) as credentials,
        (select count(*)::int from oauth_transactions) as transactions`,
    );
    expect(counts.rows[0]).toEqual({ credentials: 0, transactions: 0 });
  });

  it('rechecks membership and reconnects the canonical provider connection', async () => {
    const key = randomBytes(32);
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(key),
    };
    const adapter = new FakeProviderConnectionAdapter([
      { providerAccountId: 'one', displayName: 'One' },
      { providerAccountId: 'two', displayName: 'Two' },
    ]);
    const db = drizzle(database) as unknown as NodePgDatabase;
    const first = await connectProvider(db, keys, adapter, {
      workspaceId,
      userId,
      provider: 'fake',
      externalSubjectId: 'fake-subject',
      accessToken: 'first-secret',
      requestId: 'req-connect',
    });
    const firstAccounts = await database.query<{ id: string; remote_account_id: string }>(
      'select id, remote_account_id from provider_accounts order by remote_account_id',
    );
    const secondAdapter = new FakeProviderConnectionAdapter([
      { providerAccountId: 'one', displayName: 'One renamed' },
      { providerAccountId: 'three', displayName: 'Three' },
    ]);
    const second = await connectProvider(db, keys, secondAdapter, {
      workspaceId,
      userId,
      provider: 'fake',
      externalSubjectId: 'fake-subject',
      accessToken: 'second-secret',
      requestId: 'req-reconnect',
    });
    expect(second.connectionId).toBe(first.connectionId);
    const connectionCount = await database.query<{ count: number }>(
      'select count(*)::int as count from provider_connections',
    );
    const accountCount = await database.query<{ count: number }>(
      'select count(*)::int as count from provider_accounts',
    );
    const revokedCount = await database.query<{ count: number }>(
      'select count(*)::int as count from credentials where revoked_at is not null',
    );
    const auditRows = await database.query<{ action: string; metadata: { accountCount: number } }>(
      'select action, metadata from audit_events order by created_at',
    );
    expect(connectionCount.rows[0]?.count).toBe(1);
    expect(accountCount.rows[0]?.count).toBe(3);
    const syncedAccounts = await database.query<{
      id: string;
      remote_account_id: string;
      availability: string;
    }>(
      'select id, remote_account_id, availability from provider_accounts order by remote_account_id',
    );
    const insertedAccountId = syncedAccounts.rows[1]?.id;
    expect(typeof insertedAccountId).toBe('string');
    expect(syncedAccounts.rows).toEqual([
      { id: firstAccounts.rows[0]?.id, remote_account_id: 'one', availability: 'active' },
      { id: insertedAccountId, remote_account_id: 'three', availability: 'active' },
      { id: firstAccounts.rows[1]?.id, remote_account_id: 'two', availability: 'remote_missing' },
    ]);
    expect(revokedCount.rows[0]?.count).toBe(1);
    expect(auditRows.rows.map((row) => row.action)).toEqual([
      'provider.connected',
      'provider.reconnected',
    ]);
    expect(auditRows.rows[1]?.metadata).toEqual({ provider: 'fake', accountCount: 2 });
  });

  it('enforces connection-family and destination-provider compatibility', async () => {
    const key = randomBytes(32);
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(key),
    };
    const db = drizzle(database) as unknown as NodePgDatabase;
    const invalid = new FakeProviderConnectionAdapter([
      {
        providerAccountId: 'instagram-one',
        displayName: 'Instagram One',
        destinationProvider: 'instagram',
      },
    ]);

    await expect(
      connectProvider(db, keys, invalid, {
        workspaceId,
        userId,
        provider: 'x',
        externalSubjectId: 'numeric-subject',
        accessToken: 'invalid-secret',
        requestId: 'invalid-destination',
      }),
    ).rejects.toThrow('Destination provider instagram is incompatible with connection family x');

    const meta = new FakeProviderConnectionAdapter([
      {
        providerAccountId: 'instagram-one',
        displayName: 'Instagram One',
        destinationProvider: 'instagram',
      },
      {
        providerAccountId: 'page-one',
        displayName: 'Page One',
        destinationProvider: 'facebook_page',
      },
    ]);
    await expect(
      connectProvider(db, keys, meta, {
        workspaceId,
        userId,
        provider: 'meta',
        externalSubjectId: 'meta-subject',
        accessToken: 'meta-secret',
        requestId: 'valid-meta-destinations',
      }),
    ).resolves.toMatchObject({
      accounts: [
        { providerAccountId: 'instagram-one', destinationProvider: 'instagram' },
        { providerAccountId: 'page-one', destinationProvider: 'facebook_page' },
      ],
    });
    const rows = await database.query<{ destination_provider: string }>(
      'select destination_provider from provider_accounts order by destination_provider',
    );
    expect(rows.rows.map((row) => row.destination_provider)).toEqual([
      'facebook_page',
      'instagram',
    ]);
  });

  it('atomically reconnects Meta destinations, preserves IDs, and revokes rotated credentials', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const metaMasterKey = randomBytes(32);
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(metaMasterKey),
    };
    const connect = async (
      state: string,
      family: 'facebook_pages' | 'instagram',
      pages: {
        id: string;
        name: string;
        accessToken: string;
        tasks: string[];
        instagram?: { id: string; name: string };
      }[],
    ) => {
      const issued = await issueOauthTransaction(db, keys, {
        workspaceId,
        userId,
        provider: `meta:${family}`,
        redirectUri: 'https://relay.test/api/oauth/meta/callback',
      });
      const client = {
        exchangeCode: () =>
          Promise.resolve({
            accessToken: `authority-${state}`,
            userId: 'meta-user',
            scopes:
              family === 'facebook_pages'
                ? ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts']
                : [
                    'pages_show_list',
                    'pages_read_engagement',
                    'instagram_basic',
                    'instagram_content_publish',
                  ],
          }),
        discoverPages: () => Promise.resolve(pages),
      };
      return completeMetaOauthConnection(
        db,
        keys,
        client as never,
        {
          workspaceId,
          userId,
          state: issued.state,
          code: 'fixture-code',
          requestId: state,
        },
        {
          facebook_pages: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
          instagram: [
            'pages_show_list',
            'pages_read_engagement',
            'instagram_basic',
            'instagram_content_publish',
          ],
        },
      );
    };
    const first = await connect('first', 'facebook_pages', [
      {
        id: 'page-1',
        name: 'Page One',
        accessToken: 'page-token-1',
        tasks: ['CREATE_CONTENT'],
        instagram: { id: 'ig-1', name: 'Instagram One' },
      },
      { id: 'page-lost', name: 'Lost Page', accessToken: 'page-token-lost', tasks: [] },
    ]);
    const before = await database.query<{ id: string; remote_account_id: string }>(
      'select id, remote_account_id from provider_accounts order by remote_account_id',
    );
    await connect('second', 'facebook_pages', [
      {
        id: 'page-1',
        name: 'Page One Renamed',
        accessToken: 'page-token-2',
        tasks: ['CREATE_CONTENT'],
        instagram: { id: 'ig-1', name: 'Instagram One' },
      },
    ]);
    const after = await database.query<{
      id: string;
      remote_account_id: string;
      availability: string;
    }>(
      'select id, remote_account_id, availability from provider_accounts order by remote_account_id',
    );
    expect(after.rows.map((row) => ({ id: row.id, remote: row.remote_account_id }))).toEqual(
      before.rows.map((row) => ({ id: row.id, remote: row.remote_account_id })),
    );
    expect(after.rows.find((row) => row.remote_account_id === 'page-lost')?.availability).toBe(
      'remote_missing',
    );
    expect(
      (await listProviderAccounts(db, workspaceId)).find(
        (account) => account.displayName === 'Lost Page',
      ),
    ).toMatchObject({ availability: 'remote_missing' });
    await connect('instagram-first', 'instagram', [
      {
        id: 'page-1',
        name: 'Page One',
        accessToken: 'ig-page-token',
        tasks: [],
        instagram: { id: 'ig-1', name: 'Instagram One' },
      },
    ]);
    await expect(
      markProviderDestinationsUnavailable(db, {
        workspaceId,
        userId,
        provider: 'meta',
        connectionId: first?.connectionId ?? '',
        availability: 'reauth_required',
        requestId: 'meta-reauth-required',
      }),
    ).resolves.toBe(2);
    expect(await listProviderAccounts(db, workspaceId)).toHaveLength(3);
    expect(
      (await listProviderAccounts(db, workspaceId)).find(
        (account) => account.destinationProvider === 'instagram',
      )?.availability,
    ).toBe('active');
    expect(
      (await listProviderAccounts(db, workspaceId))
        .filter((account) => account.destinationProvider === 'facebook_page')
        .every((account) => account.availability === 'reauth_required'),
    ).toBe(true);
    await expect(
      markProviderDestinationsUnavailable(db, {
        workspaceId,
        userId,
        provider: 'meta',
        connectionId: first?.connectionId ?? '',
        availability: 'permission_lost',
        requestId: 'meta-permission-lost',
      }),
    ).resolves.toBe(2);
    expect(await listProviderAccounts(db, workspaceId)).toHaveLength(3);
    expect(
      (await listProviderAccounts(db, workspaceId))
        .filter((account) => account.destinationProvider === 'facebook_page')
        .every((account) => account.availability === 'permission_lost'),
    ).toBe(true);
    const credentials = await database.query<{ active: number; revoked: number }>(
      `select
         count(*) filter (where revoked_at is null)::int as active,
         count(*) filter (where revoked_at is not null)::int as revoked
       from credentials`,
    );
    expect(credentials.rows[0]).toMatchObject({ active: 4, revoked: 3 });
    const actions = await database.query<{ action: string }>(
      "select action from audit_events where action like 'provider.destination.%' order by action",
    );
    expect(actions.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'provider.destination.credential_rotated',
        'provider.destination.discovered',
        'provider.destination.lost',
      ]),
    );
  });

  it('rejects empty Instagram discovery before any first-connect or reconnect write', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(Buffer.alloc(32, 15)),
    };
    const connect = async (requestId: string, hasInstagram: boolean) => {
      const issued = await issueOauthTransaction(db, keys, {
        workspaceId,
        userId,
        provider: 'meta:instagram',
        redirectUri: 'https://relay.test/api/oauth/meta/callback',
      });
      return completeMetaOauthConnection(
        db,
        keys,
        {
          exchangeCode: () =>
            Promise.resolve({
              accessToken: `authority-${requestId}`,
              userId: 'meta-user',
              scopes: [
                'pages_show_list',
                'pages_read_engagement',
                'instagram_basic',
                'instagram_content_publish',
              ],
            }),
          discoverPages: () =>
            Promise.resolve([
              {
                id: 'page-1',
                name: 'Page One',
                accessToken: 'page-token',
                tasks: [],
                ...(hasInstagram ? { instagram: { id: 'ig-1', name: 'Instagram One' } } : {}),
              },
            ]),
        } as never,
        { workspaceId, userId, state: issued.state, code: 'fixture-code', requestId },
        {
          instagram: [
            'pages_show_list',
            'pages_read_engagement',
            'instagram_basic',
            'instagram_content_publish',
          ],
        },
      );
    };
    const snapshot = async () => {
      const rows = await database.query<{
        connection_id: string;
        credential_id: string;
        account_id: string;
        availability: string;
      }>(`select connection.id as connection_id, connection.credential_id,
                  account.id as account_id, account.availability
           from provider_connections connection
           left join provider_accounts account on account.connection_id = connection.id
           where connection.provider = 'meta'`);
      const credentials = await database.query<{ count: number }>(
        'select count(*)::int as count from credentials',
      );
      return { rows: rows.rows, credentialCount: credentials.rows[0]?.count };
    };
    await expect(connect('empty-first', false)).rejects.toMatchObject({
      family: 'instagram',
      cause: expect.any(MetaNoUsableDestinationsError),
    } satisfies Partial<MetaFamilyCallbackError>);
    expect(await snapshot()).toEqual({ rows: [], credentialCount: 0 });

    await connect('valid', true);
    const beforeReconnect = await snapshot();
    expect(beforeReconnect.rows).toHaveLength(1);
    expect(beforeReconnect.rows[0]?.availability).toBe('active');
    await expect(connect('empty-reconnect', false)).rejects.toMatchObject({
      family: 'instagram',
      cause: expect.any(MetaNoUsableDestinationsError),
    } satisfies Partial<MetaFamilyCallbackError>);
    expect(await snapshot()).toEqual(beforeReconnect);
    const completed = await database.query<{ count: number }>(
      "select count(*)::int as count from audit_events where action = 'meta.discovery.completed'",
    );
    expect(completed.rows[0]?.count).toBe(1);
  });

  it('disconnects only a pre-existing empty Instagram family grant on zero-result consent', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(Buffer.alloc(32, 15)),
    };
    const emptyCredential = await createCredential(db, workspaceId, encrypted(21));
    const pageCredential = await createCredential(db, workspaceId, encrypted(22));
    const empty = await database.query<{ id: string }>(
      `insert into provider_connections
         (workspace_id, provider, grant_family, external_subject_id, credential_id)
       values ($1, 'meta', 'instagram', 'meta-user', $2) returning id`,
      [workspaceId, emptyCredential.id],
    );
    const page = await database.query<{ id: string }>(
      `insert into provider_connections
         (workspace_id, provider, grant_family, external_subject_id, credential_id)
       values ($1, 'meta', 'facebook_pages', 'meta-user', $2) returning id`,
      [workspaceId, pageCredential.id],
    );
    await database.query(
      `insert into provider_accounts
         (workspace_id, connection_id, provider_account_id, destination_provider,
          remote_account_id, display_name, availability)
       values ($1, $2, 'page-1', 'facebook_page', 'page-1', 'Page One', 'active')`,
      [workspaceId, page.rows[0]?.id],
    );
    const issued = await issueOauthTransaction(db, keys, {
      workspaceId,
      userId,
      provider: 'meta:instagram',
      redirectUri: 'https://relay.test/api/oauth/meta/callback',
    });
    await expect(
      completeMetaOauthConnection(
        db,
        keys,
        {
          exchangeCode: () =>
            Promise.resolve({
              accessToken: 'new-authority',
              userId: 'meta-user',
              scopes: ['instagram_basic', 'instagram_content_publish'],
            }),
          discoverPages: () => Promise.resolve([]),
        } as never,
        {
          workspaceId,
          userId,
          state: issued.state,
          code: 'fixture-code',
          requestId: 'empty-legacy',
        },
        { instagram: ['instagram_basic', 'instagram_content_publish'] },
      ),
    ).rejects.toMatchObject({
      family: 'instagram',
      cause: expect.any(MetaNoUsableDestinationsError),
    } satisfies Partial<MetaFamilyCallbackError>);
    const grants = await database.query<{
      id: string;
      grant_family: string;
      status: string;
      revoked_at: Date | null;
      account_count: number;
    }>(
      `select connection.id, connection.grant_family, connection.status, credential.revoked_at,
              count(account.id)::int as account_count
       from provider_connections connection
       join credentials credential on credential.id = connection.credential_id
       left join provider_accounts account on account.connection_id = connection.id
       where connection.provider = 'meta'
       group by connection.id, credential.id
       order by connection.grant_family`,
    );
    expect(grants.rows).toHaveLength(2);
    expect(grants.rows[0]).toEqual({
      id: page.rows[0]?.id,
      grant_family: 'facebook_pages',
      status: 'active',
      revoked_at: null,
      account_count: 1,
    });
    expect(grants.rows[1]).toMatchObject({
      id: empty.rows[0]?.id,
      grant_family: 'instagram',
      status: 'disconnected',
      account_count: 0,
    });
    expect(grants.rows[1]?.revoked_at).toBeInstanceOf(Date);
    const writes = await database.query<{ count: number }>(
      "select count(*)::int as count from audit_events where action = 'meta.discovery.completed'",
    );
    expect(writes.rows[0]?.count).toBe(0);
  });

  it('keeps Instagram Login destination identity stable and preserves a valid grant on failed reconnect', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(Buffer.alloc(32, 23)),
    };
    const connect = async (requestId: string, fails = false) => {
      const issued = await issueOauthTransaction(db, keys, {
        workspaceId,
        userId,
        provider: 'instagram_login',
        redirectUri: 'https://relay.test/api/oauth/instagram/callback',
      });
      return completeInstagramLogin(
        db,
        keys,
        {
          exchangeCode: () =>
            fails
              ? Promise.reject(new Error('Instagram token exchange failed'))
              : Promise.resolve({
                  accessToken: `ig-token-${requestId}`,
                  appScopedUserId: 'app-user-1',
                  remoteUserId: 'ig-user-1',
                  username: 'publisher',
                  expiresAt: new Date('2026-12-01T00:00:00Z'),
                }),
        } as never,
        { workspaceId, userId, state: issued.state, code: 'code', requestId },
      );
    };
    await connect('first');
    const before = await database.query<{
      id: string;
      connection_id: string;
      credential_id: string;
      availability: string;
      destination_provider: string;
      remote_account_id: string;
      status: string;
    }>(
      `select account.id, account.connection_id, account.credential_id,
              account.availability, account.destination_provider, account.remote_account_id,
              connection.status
       from provider_accounts account join provider_connections connection
         on connection.id = account.connection_id
       where connection.provider = 'instagram_login'`,
    );
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0]).toMatchObject({
      availability: 'publishing_unavailable',
      destination_provider: 'instagram',
      remote_account_id: 'ig-user-1',
      status: 'active',
    });
    await expect(connect('failed', true)).rejects.toThrow('Instagram token exchange failed');
    const afterFailure = await database.query(
      "select id, credential_id from provider_connections where provider = 'instagram_login'",
    );
    expect(afterFailure.rows[0]).toMatchObject({
      id: before.rows[0]?.connection_id,
      credential_id: before.rows[0]?.credential_id,
    });
    await connect('reconnected');
    const after = await database.query<{
      id: string;
      connection_id: string;
      credential_id: string;
    }>(
      `select account.id, account.connection_id, account.credential_id
       from provider_accounts account join provider_connections connection
         on connection.id = account.connection_id
       where connection.provider = 'instagram_login'`,
    );
    expect(after.rows[0]?.id).toBe(before.rows[0]?.id);
    expect(after.rows[0]?.connection_id).toBe(before.rows[0]?.connection_id);
    expect(after.rows[0]?.credential_id).not.toBe(before.rows[0]?.credential_id);
    const credentials = await database.query<{ active: number; revoked: number }>(
      `select count(*) filter (where revoked_at is null)::int as active,
              count(*) filter (where revoked_at is not null)::int as revoked
       from credentials`,
    );
    expect(credentials.rows[0]).toEqual({ active: 1, revoked: 1 });
    expect(
      await getFreshInstagramLoginToken(
        db,
        keys,
        {
          refreshToken: (token: string) => {
            expect(token).toBe('ig-token-reconnected');
            return Promise.resolve({
              accessToken: 'ig-token-refreshed',
              expiresAt: new Date('2027-01-29T00:00:00Z'),
            });
          },
        } as never,
        {
          workspaceId,
          appScopedUserId: 'app-user-1',
          requestId: 'refresh',
          now: new Date('2026-11-30T12:00:00Z'),
        },
      ),
    ).toBe('ig-token-refreshed');
    const refreshed = await database.query<{ version: number; access_expires_at: Date }>(
      `select credential.version, connection.access_expires_at
       from provider_connections connection join credentials credential
         on credential.id = connection.credential_id
       where connection.provider = 'instagram_login'`,
    );
    expect(refreshed.rows[0]).toEqual({
      version: 2,
      access_expires_at: new Date('2027-01-29T00:00:00Z'),
    });
    const accountId = before.rows[0]?.id;
    if (!accountId) throw new Error('Missing Instagram Login account fixture');
    const connectionId = before.rows[0]?.connection_id;
    if (!connectionId) throw new Error('Missing Instagram Login connection fixture');
    const promotionInput = {
      workspaceId,
      accountId,
      requestId: 'reviewed-release-promotion',
      now: new Date('2026-12-01T00:00:00Z'),
    };
    const mismatchedIdentity = {
      lookupAccount: () =>
        Promise.resolve({ appScopedUserId: 'app-user-1', remoteUserId: 'other-ig-user' }),
    } as never;
    await expect(
      promoteInstagramLoginAccount(db, keys, mismatchedIdentity, promotionInput),
    ).resolves.toBe(false);
    const beforePromotion = await database.query<{ availability: string }>(
      `select availability from provider_accounts where id = '${accountId}'`,
    );
    expect(beforePromotion.rows[0]?.availability).toBe('publishing_unavailable');
    const matchingIdentity = {
      lookupAccount: (token: string) => {
        expect(token).toBe('ig-token-refreshed');
        return Promise.resolve({ appScopedUserId: 'app-user-1', remoteUserId: 'ig-user-1' });
      },
    } as never;
    await database.exec(`UPDATE provider_connections SET scopes = '["instagram_business_basic"]'
      WHERE id = '${connectionId}'`);
    await database.exec(`UPDATE provider_connections SET access_expires_at = '2026-12-01T12:00:00Z'
      WHERE id = '${connectionId}'`);
    let partialRefreshCalls = 0;
    const partialClient = {
      refreshToken: () => {
        partialRefreshCalls += 1;
        return Promise.resolve({ accessToken: 'unexpected', expiresAt: new Date('2027-01-01') });
      },
      lookupAccount: () => {
        throw new Error('Partial grant must not reach identity lookup');
      },
    } as never;
    await expect(
      getFreshInstagramLoginToken(db, keys, partialClient, {
        workspaceId,
        appScopedUserId: 'app-user-1',
        requestId: 'partial-refresh',
        now: promotionInput.now,
      }),
    ).rejects.toThrow('permission is incomplete');
    await expect(
      promoteInstagramLoginAccount(db, keys, partialClient, promotionInput),
    ).resolves.toBe(false);
    expect(partialRefreshCalls).toBe(0);
    const partialGrant = await database.query<{ scopes: string[]; availability: string }>(
      `select connection.scopes, account.availability from provider_connections connection
       join provider_accounts account on account.connection_id = connection.id
       where connection.id = '${connectionId}'`,
    );
    expect(partialGrant.rows[0]).toMatchObject({
      scopes: ['instagram_business_basic'],
      availability: 'publishing_unavailable',
    });
    const partialAudit = await database.query<{ count: number }>(
      "select count(*)::int as count from audit_events where request_id in ('partial-refresh', 'reviewed-release-promotion')",
    );
    expect(partialAudit.rows[0]?.count).toBe(0);
    await expect(
      promoteInstagramLoginAccount(db, keys, matchingIdentity, promotionInput),
    ).resolves.toBe(false);
    await database.exec(`UPDATE provider_connections
      SET scopes = '["instagram_business_basic","instagram_business_content_publish"]'
      WHERE id = '${connectionId}'`);
    await expect(
      getFreshInstagramLoginToken(
        db,
        keys,
        {
          refreshToken: async () => {
            await database.exec(`UPDATE provider_connections
              SET scopes = '["instagram_business_basic"]' WHERE id = '${connectionId}'`);
            return { accessToken: 'unverified-refresh', expiresAt: new Date('2027-01-01') };
          },
        } as never,
        {
          workspaceId,
          appScopedUserId: 'app-user-1',
          requestId: 'scope-race-refresh',
          now: promotionInput.now,
        },
      ),
    ).rejects.toThrow('permission is incomplete');
    const racedGrant = await database.query<{ scopes: string[]; version: number }>(
      `select connection.scopes, credential.version from provider_connections connection
       join credentials credential on credential.id = connection.credential_id
       where connection.id = '${connectionId}'`,
    );
    expect(racedGrant.rows[0]).toEqual({ scopes: ['instagram_business_basic'], version: 2 });
    await database.exec(`UPDATE provider_connections
      SET scopes = '["instagram_business_basic","instagram_business_content_publish"]',
          access_expires_at = '2027-01-29T00:00:00Z'
      WHERE id = '${connectionId}'`);
    await expect(
      promoteInstagramLoginAccount(db, keys, matchingIdentity, {
        ...promotionInput,
        workspaceId: '00000000-0000-4000-8000-000000000999',
      }),
    ).resolves.toBe(false);
    await expect(
      promoteInstagramLoginAccount(db, keys, matchingIdentity, promotionInput),
    ).resolves.toBe(true);
    await expect(
      promoteInstagramLoginAccount(db, keys, matchingIdentity, promotionInput),
    ).resolves.toBe(false);
    const promoted = await database.query<{ availability: string }>(
      `select availability from provider_accounts where id = '${accountId}'`,
    );
    expect(promoted.rows[0]?.availability).toBe('active');
    const promotionAudit = await database.query<{ count: number }>(
      "select count(*)::int as count from audit_events where action = 'instagram.login.publishing_enabled'",
    );
    expect(promotionAudit.rows[0]?.count).toBe(1);
  });

  it('makes legacy Facebook Login Instagram destinations inert without changing the Page sibling', async () => {
    const instagramCredential = await createCredential(
      drizzle(database) as unknown as NodePgDatabase,
      workspaceId,
      encrypted(24),
    );
    const facebookCredential = await createCredential(
      drizzle(database) as unknown as NodePgDatabase,
      workspaceId,
      encrypted(25),
    );
    const instagram = await database.query<{ id: string }>(
      `insert into provider_connections
         (workspace_id, provider, grant_family, external_subject_id, credential_id)
       values ($1, 'meta', 'instagram', 'meta-user', $2) returning id`,
      [workspaceId, instagramCredential.id],
    );
    const facebook = await database.query<{ id: string }>(
      `insert into provider_connections
         (workspace_id, provider, grant_family, external_subject_id, credential_id)
       values ($1, 'meta', 'facebook_pages', 'meta-user', $2) returning id`,
      [workspaceId, facebookCredential.id],
    );
    await database.query(
      `insert into provider_accounts
         (workspace_id, connection_id, provider_account_id, destination_provider,
          remote_account_id, display_name, availability)
       values ($1, $2, 'ig-1', 'instagram', 'ig-1', 'Instagram', 'active'),
              ($1, $3, 'page-1', 'facebook_page', 'page-1', 'Page', 'active')`,
      [workspaceId, instagram.rows[0]?.id, facebook.rows[0]?.id],
    );
    await database.exec(
      await readFile(
        new URL('../migrations/0057_instagram_login_legacy_grants.sql', import.meta.url),
        'utf8',
      ),
    );
    const rows = await database.query<{
      destination_provider: string;
      availability: string;
      disconnected_at: Date | null;
      status: string;
    }>(
      `select account.destination_provider, account.availability,
              account.disconnected_at, connection.status
       from provider_accounts account join provider_connections connection
         on connection.id = account.connection_id
       order by account.destination_provider`,
    );
    expect(rows.rows[0]).toEqual({
      destination_provider: 'facebook_page',
      availability: 'active',
      disconnected_at: null,
      status: 'active',
    });
    expect(rows.rows[1]).toMatchObject({
      destination_provider: 'instagram',
      availability: 'reauth_required',
      status: 'disconnected',
    });
    expect(rows.rows[1]?.disconnected_at).toBeInstanceOf(Date);
  });

  it('re-homes an exact-ID inert legacy Instagram account without duplicating its identity', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(Buffer.alloc(32, 26)),
    };
    const credential = await createCredential(db, workspaceId, encrypted(26));
    const oldConnection = await database.query<{ id: string }>(
      `insert into provider_connections
         (workspace_id, provider, grant_family, external_subject_id, credential_id, status)
       values ($1, 'meta', 'instagram', 'old-meta-user', $2, 'disconnected') returning id`,
      [workspaceId, credential.id],
    );
    const oldAccount = await database.query<{ id: string }>(
      `insert into provider_accounts
         (workspace_id, connection_id, provider_account_id, destination_provider,
          remote_account_id, display_name, availability, disconnected_at)
       values ($1, $2, 'ig-user-1', 'instagram', 'ig-user-1', 'old-name',
               'reauth_required', now()) returning id`,
      [workspaceId, oldConnection.rows[0]?.id],
    );
    const issued = await issueOauthTransaction(db, keys, {
      workspaceId,
      userId,
      provider: 'instagram_login',
      redirectUri: 'https://relay.test/api/oauth/instagram/callback',
    });
    await completeInstagramLogin(
      db,
      keys,
      {
        exchangeCode: () =>
          Promise.resolve({
            accessToken: 'new-token',
            appScopedUserId: 'new-app-scoped-id',
            remoteUserId: 'ig-user-1',
            username: 'new-name',
            expiresAt: new Date('2026-12-01T00:00:00Z'),
          }),
      } as never,
      { workspaceId, userId, state: issued.state, code: 'code', requestId: 'rehome' },
    );
    const accounts = await database.query<{
      id: string;
      provider: string;
      availability: string;
      disconnected_at: Date | null;
    }>(
      `select account.id, connection.provider, account.availability, account.disconnected_at
       from provider_accounts account join provider_connections connection
         on connection.id = account.connection_id`,
    );
    expect(accounts.rows).toEqual([
      {
        id: oldAccount.rows[0]?.id,
        provider: 'instagram_login',
        availability: 'publishing_unavailable',
        disconnected_at: null,
      },
    ]);
  });

  it('re-homes an inert Instagram account from an active combined Meta grant while preserving its Page and jobs', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(Buffer.alloc(32, 27)),
    };
    const authority = await createCredential(db, workspaceId, encrypted(27));
    const sharedPageToken = await createCredential(db, workspaceId, encrypted(28));
    const combined = await database.query<{ id: string }>(
      `INSERT INTO provider_connections (workspace_id, provider, external_subject_id, credential_id)
       VALUES ($1, 'meta', 'combined-meta-user', $2) RETURNING id`,
      [workspaceId, authority.id],
    );
    const accounts = await database.query<{ id: string; destination_provider: string }>(
      `INSERT INTO provider_accounts
         (workspace_id, connection_id, provider_account_id, destination_provider,
          remote_account_id, display_name, credential_id, availability)
       VALUES ($1, $2, 'page-1', 'facebook_page', 'page-1', 'Page', $3, 'active'),
              ($1, $2, 'ig-user-1', 'instagram', 'ig-user-1', 'Instagram', $3, 'active')
       RETURNING id, destination_provider`,
      [workspaceId, combined.rows[0]?.id, sharedPageToken.id],
    );
    const instagramId = accounts.rows.find((row) => row.destination_provider === 'instagram')?.id;
    const pageId = accounts.rows.find((row) => row.destination_provider === 'facebook_page')?.id;
    await database.query('INSERT INTO posts (workspace_id, created_by_user_id) VALUES ($1, $2)', [
      workspaceId,
      userId,
    ]);
    const post = await database.query<{ id: string }>('SELECT id FROM posts LIMIT 1');
    const revision = await database.query<{ id: string }>(
      `INSERT INTO post_revisions (workspace_id, post_id, revision_number, content)
       VALUES ($1, $2, 1, '{}') RETURNING id`,
      [workspaceId, post.rows[0]?.id],
    );
    const job = await database.query<{ id: string }>(
      `INSERT INTO publication_jobs (workspace_id, post_id, revision_id, provider_account_id, scheduled_at, state)
       VALUES ($1, $2, $3, $4, now(), 'scheduled') RETURNING id`,
      [workspaceId, post.rows[0]?.id, revision.rows[0]?.id, instagramId],
    );
    await database.exec(
      await readFile(
        new URL('../migrations/0057_instagram_login_legacy_grants.sql', import.meta.url),
        'utf8',
      ),
    );
    const issued = await issueOauthTransaction(db, keys, {
      workspaceId,
      userId,
      provider: 'instagram_login',
      redirectUri: 'https://relay.test/api/oauth/instagram/callback',
    });
    await completeInstagramLogin(
      db,
      keys,
      {
        exchangeCode: () =>
          Promise.resolve({
            accessToken: 'new-token',
            appScopedUserId: 'app-user-1',
            remoteUserId: 'ig-user-1',
            username: 'new-name',
            expiresAt: new Date('2026-12-01T00:00:00Z'),
          }),
      } as never,
      { workspaceId, userId, state: issued.state, code: 'code', requestId: 'combined-rehome' },
    );
    const after = await database.query<{
      id: string;
      destination_provider: string;
      connection_id: string;
      provider: string;
      credential_id: string | null;
      availability: string;
      status: string;
    }>(
      `SELECT account.id, account.destination_provider, account.connection_id,
              connection.provider, account.credential_id, account.availability, connection.status
       FROM provider_accounts account JOIN provider_connections connection ON connection.id = account.connection_id
       ORDER BY account.destination_provider`,
    );
    expect(after.rows).toHaveLength(2);
    expect(after.rows[0]).toMatchObject({
      id: pageId,
      connection_id: combined.rows[0]?.id,
      provider: 'meta',
      credential_id: sharedPageToken.id,
      availability: 'active',
      status: 'active',
    });
    expect(after.rows[1]).toMatchObject({
      id: instagramId,
      provider: 'instagram_login',
      availability: 'publishing_unavailable',
      status: 'active',
    });
    const pageTokens = await database.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM credentials WHERE id = $1',
      [sharedPageToken.id],
    );
    expect(pageTokens.rows[0]?.revoked_at).toBeNull();
    const jobs = await database.query<{ id: string; provider_account_id: string }>(
      'SELECT id, provider_account_id FROM publication_jobs',
    );
    expect(jobs.rows).toEqual([{ id: job.rows[0]?.id, provider_account_id: instagramId }]);

    const connectDifferentSubject = async (remoteUserId: string) => {
      const next = await issueOauthTransaction(db, keys, {
        workspaceId,
        userId,
        provider: 'instagram_login',
        redirectUri: 'https://relay.test/api/oauth/instagram/callback',
      });
      return completeInstagramLogin(
        db,
        keys,
        {
          exchangeCode: () =>
            Promise.resolve({
              accessToken: 'other-token',
              appScopedUserId: 'different-app-subject',
              remoteUserId,
              username: 'other-name',
              expiresAt: new Date('2026-12-01T00:00:00Z'),
            }),
        } as never,
        { workspaceId, userId, state: next.state, code: 'code', requestId: 'other-subject' },
      );
    };
    await expect(connectDifferentSubject('ig-user-1')).rejects.toBeInstanceOf(
      ProviderDestinationConflictError,
    );
    await connectDifferentSubject('ig-user-2');
    const afterMismatch = await database.query<{ id: string; remote_account_id: string }>(
      "SELECT id, remote_account_id FROM provider_accounts WHERE destination_provider = 'instagram' ORDER BY remote_account_id",
    );
    expect(afterMismatch.rows).toHaveLength(2);
    expect(afterMismatch.rows[0]).toEqual({ id: instagramId, remote_account_id: 'ig-user-1' });
    expect(afterMismatch.rows[1]?.id).not.toBe(instagramId);
    expect(afterMismatch.rows[1]?.remote_account_id).toBe('ig-user-2');
  });

  it('rejects a Page grant without publishing access and ignores legacy combined state', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(Buffer.alloc(32, 16)),
    };
    const client = {
      exchangeCode: () =>
        Promise.resolve({
          accessToken: 'authority',
          userId: 'meta-user',
          scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
        }),
      discoverPages: () =>
        Promise.resolve([
          {
            id: 'page-1',
            name: 'Page One',
            accessToken: 'page-token',
            tasks: [],
          },
        ]),
    };
    const callback = async (provider: string) => {
      const issued = await issueOauthTransaction(db, keys, {
        workspaceId,
        userId,
        provider,
        redirectUri: 'https://relay.test/api/oauth/meta/callback',
      });
      return completeMetaOauthConnection(
        db,
        keys,
        client as never,
        { workspaceId, userId, state: issued.state, code: 'fixture-code', requestId: provider },
        { facebook_pages: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'] },
      );
    };
    await expect(callback('meta:facebook_pages')).rejects.toMatchObject({
      family: 'facebook_pages',
      cause: expect.any(MetaNoUsableDestinationsError),
    } satisfies Partial<MetaFamilyCallbackError>);
    expect(await callback('meta')).toBeNull();
    expect(client.exchangeCode).toBeDefined();
    const count = await database.query<{ count: number }>(
      "select count(*)::int as count from provider_connections where provider = 'meta'",
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  it('re-homes only matching legacy Meta destinations after explicit family consent without changing job IDs', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(Buffer.alloc(32, 7)),
    };
    await connectProvider(
      db,
      keys,
      new FakeProviderConnectionAdapter([
        { providerAccountId: 'page-1', destinationProvider: 'facebook_page', displayName: 'Page' },
        { providerAccountId: 'ig-1', destinationProvider: 'instagram', displayName: 'Instagram' },
      ]),
      {
        workspaceId,
        userId,
        provider: 'meta',
        externalSubjectId: 'meta-user',
        accessToken: 'legacy-authority',
        requestId: 'legacy',
      },
    );
    const before = await database.query<{ id: string; destination_provider: string }>(
      'select id, destination_provider from provider_accounts order by destination_provider',
    );
    const pageId = before.rows.find((row) => row.destination_provider === 'facebook_page')?.id;
    await database.exec(`
      UPDATE provider_connections SET status = 'disconnected' WHERE provider = 'meta' AND grant_family IS NULL;
      UPDATE provider_accounts SET availability = 'reauth_required' WHERE destination_provider IN ('facebook_page', 'instagram');
    `);
    await database.query('INSERT INTO posts (workspace_id, created_by_user_id) VALUES ($1, $2)', [
      workspaceId,
      userId,
    ]);
    const post = await database.query<{ id: string }>('SELECT id FROM posts LIMIT 1');
    const revision = await database.query<{ id: string }>(
      `INSERT INTO post_revisions (workspace_id, post_id, revision_number, content)
       VALUES ($1, $2, 1, '{}') RETURNING id`,
      [workspaceId, post.rows[0]?.id],
    );
    const job = await database.query<{ id: string }>(
      `INSERT INTO publication_jobs (workspace_id, post_id, revision_id, provider_account_id, scheduled_at, state)
       VALUES ($1, $2, $3, $4, now(), 'scheduled') RETURNING id`,
      [workspaceId, post.rows[0]?.id, revision.rows[0]?.id, pageId],
    );
    const connectFamily = async (family: 'facebook_pages' | 'instagram') => {
      const issued = await issueOauthTransaction(db, keys, {
        workspaceId,
        userId,
        provider: `meta:${family}`,
        redirectUri: 'https://relay.test/api/oauth/meta/callback',
      });
      return completeMetaOauthConnection(
        db,
        keys,
        {
          exchangeCode: () =>
            Promise.resolve({ accessToken: 'new-authority', userId: 'meta-user', scopes: [] }),
          discoverPages: () =>
            Promise.resolve([
              {
                id: 'page-1',
                name: 'Page',
                accessToken: 'page-token',
                tasks: ['CREATE_CONTENT'],
                instagram: { id: 'ig-1', name: 'Instagram' },
              },
            ]),
        } as never,
        {
          workspaceId,
          userId,
          state: issued.state,
          code: 'fixture-code',
          requestId: family,
        },
        {
          facebook_pages: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
          instagram: [
            'pages_show_list',
            'pages_read_engagement',
            'instagram_basic',
            'instagram_content_publish',
          ],
        },
      );
    };
    await connectFamily('instagram');
    await connectFamily('facebook_pages');
    const after = await database.query<{
      id: string;
      destination_provider: string;
      grant_family: string;
    }>(
      `select account.id, account.destination_provider, connection.grant_family
       from provider_accounts account join provider_connections connection on connection.id = account.connection_id
       order by account.destination_provider`,
    );
    expect(
      after.rows.map((row) => ({ id: row.id, destination: row.destination_provider })),
    ).toEqual(before.rows.map((row) => ({ id: row.id, destination: row.destination_provider })));
    expect(after.rows.map((row) => row.grant_family)).toEqual(['facebook_pages', 'instagram']);
    const jobs = await database.query<{ id: string; provider_account_id: string }>(
      'select id, provider_account_id from publication_jobs',
    );
    expect(jobs.rows[0]).toMatchObject({ id: job.rows[0]?.id, provider_account_id: pageId });
  });

  it('consumes Meta state and leaves no connection after a sanitized debug_token 400', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(Buffer.alloc(32, 9)),
    };
    const issued = await issueOauthTransaction(db, keys, {
      workspaceId,
      userId,
      provider: 'meta:facebook_pages',
      redirectUri: 'https://relay.test/api/oauth/meta/callback',
    });
    const input = {
      workspaceId,
      userId,
      state: issued.state,
      code: 'fixture-code',
      requestId: 'debug-400',
    };
    const client = {
      exchangeCode: () => Promise.reject(new MetaRequestError(400, 'permanent')),
      discoverPages: () => Promise.reject(new Error('Discovery must not run')),
    };
    const permissions = {
      facebook_pages: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'] as const,
    };
    await expect(
      completeMetaOauthConnection(db, keys, client as never, input, permissions),
    ).rejects.toThrow('Meta connection did not complete');
    await expect(
      completeMetaOauthConnection(db, keys, client as never, input, permissions),
    ).resolves.toBeNull();
    const count = await database.query<{ count: number }>(
      `select count(*)::int as count from provider_connections where provider = 'meta'`,
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  it('does not consume another provider state presented to the Meta callback', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(Buffer.alloc(32, 11)),
    };
    const issued = await issueOauthTransaction(db, keys, {
      workspaceId,
      userId,
      provider: 'linkedin',
      redirectUri: 'https://relay.test/api/oauth/linkedin/callback',
    });
    const input = {
      workspaceId,
      userId,
      state: issued.state,
      code: 'fixture-code',
      requestId: 'wrong-family',
    };
    await expect(completeMetaOauthConnection(db, keys, {} as never, input)).resolves.toBeNull();
    await expect(
      consumeOauthCallback(db, keys, {
        workspaceId,
        userId,
        state: issued.state,
        provider: 'linkedin',
      }),
    ).resolves.toMatchObject({ provider: 'linkedin' });
  });

  it('denies X connection before provider, OAuth, credential, or idempotency artifacts', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    let providerCalls = 0;
    let policyCalls = 0;
    const policy: ActionPolicy = {
      evaluate(context) {
        policyCalls += 1;
        expect(context).toMatchObject({
          workspaceId,
          actor: { type: 'user', id: userId },
          action: 'provider-account.connect',
          request: { provider: 'x', requestId: 'oauth-start' },
        });
        return Promise.resolve({ allowed: false, code: 'action_denied', reason: 'Not allowed' });
      },
    };
    const client = new XHttpClient({
      consumerKey: 'consumer-key',
      consumerSecret: 'consumer-secret',
      fetch: () => {
        providerCalls += 1;
        throw new Error('Provider must not be called');
      },
    });
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(randomBytes(32)),
    };

    await expect(
      beginXOauthConnection(
        db,
        keys,
        client,
        { workspaceId, userId, callbackUrl: 'https://app.test/callback', requestId: 'oauth-start' },
        policy,
      ),
    ).rejects.toMatchObject({ code: 'action_denied' });
    expect(policyCalls).toBe(1);
    expect(providerCalls).toBe(0);
    const counts = await database.query<{
      oauth_transactions: number;
      credentials: number;
      connections: number;
      accounts: number;
    }>(`select
      (select count(*)::int from oauth_transactions) oauth_transactions,
      (select count(*)::int from credentials) credentials,
      (select count(*)::int from provider_connections) connections,
      (select count(*)::int from provider_accounts) accounts`);
    expect(counts.rows[0]).toEqual({
      oauth_transactions: 0,
      credentials: 0,
      connections: 0,
      accounts: 0,
    });
  });

  it('consumes an encrypted X request-token secret once and creates the canonical connection', async () => {
    const key = randomBytes(32);
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(key),
    };
    const responses = [
      new Response(
        'oauth_token=request-token&oauth_token_secret=request-secret&oauth_callback_confirmed=true',
      ),
      new Response('oauth_token=access-token&oauth_token_secret=access-secret'),
      Response.json({
        data: { id: '123456789', name: 'Example Editorial', username: 'example_editorial' },
      }),
    ];
    const client = new XHttpClient({
      consumerKey: 'consumer-key',
      consumerSecret: 'consumer-secret',
      fetch: () => {
        const response = responses.shift();
        if (!response) throw new Error('Unexpected X test request');
        return Promise.resolve(response);
      },
      nonce: () => 'nonce',
      now: () => Date.parse('2026-08-31T12:00:00.000Z'),
    });
    const db = drizzle(database) as unknown as NodePgDatabase;
    const begun = await beginXOauthConnection(db, keys, client, {
      workspaceId,
      userId,
      callbackUrl: 'https://app.example.test/oauth/x/callback',
    });
    expect(begun.authorizationUrl).toContain('oauth_token=request-token');
    const persisted = await database.query<{ state_hash: string; ciphertext: Uint8Array }>(
      `select transaction.state_hash, credential.ciphertext
       from oauth_transactions transaction
       join credentials credential on credential.id = transaction.secret_credential_id`,
    );
    expect(persisted.rows[0]?.state_hash).toBe(hashOauthState('request-token'));
    expect(JSON.stringify(persisted.rows[0])).not.toContain('request-secret');
    await expect(
      completeXOauthConnection(db, keys, client, {
        workspaceId,
        userId: '00000000-0000-4000-8000-000000000103',
        requestToken: 'request-token',
        verifier: 'verifier',
        requestId: 'x-connect-wrong-user',
      }),
    ).resolves.toBeNull();
    const connected = await completeXOauthConnection(db, keys, client, {
      workspaceId,
      userId,
      requestToken: 'request-token',
      verifier: 'verifier',
      requestId: 'x-connect',
    });
    expect(connected?.accounts).toEqual([
      { providerAccountId: '123456789', displayName: 'Example Editorial (@example_editorial)' },
    ]);
    await expect(
      completeXOauthConnection(db, keys, client, {
        workspaceId,
        userId,
        requestToken: 'request-token',
        verifier: 'verifier',
        requestId: 'x-connect-retry',
      }),
    ).resolves.toBeNull();
    const counts = await database.query<{ transactions: number; active_credentials: number }>(
      `select
        (select count(*)::int from oauth_transactions) as transactions,
        (select count(*)::int from credentials where revoked_at is null) as active_credentials`,
    );
    expect(counts.rows[0]).toEqual({ transactions: 0, active_credentials: 1 });
  });

  it('lists an allowlisted account summary and revokes the final disconnected credential', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const key = randomBytes(32);
    const keys: MasterKeyProvider = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(key),
    };
    await connectProvider(
      db,
      keys,
      new FakeProviderConnectionAdapter([
        {
          providerAccountId: 'external-account',
          displayName: 'Example Editorial (@exampleeditorial)',
        },
      ]),
      {
        workspaceId,
        userId,
        provider: 'x',
        externalSubjectId: 'external-account',
        accessToken: 'secret-token',
        requestId: 'req-connect-account',
      },
    );
    const foreignWorkspaceId = '00000000-0000-4000-8000-000000000191';
    const foreignAccountId = '00000000-0000-4000-8000-000000000194';
    await database.exec(`
      INSERT INTO workspaces (id, name, slug)
      VALUES ('${foreignWorkspaceId}', 'Foreign Workspace', 'foreign-workspace');
      SELECT set_config('app.workspace_id', '${foreignWorkspaceId}', false);
      INSERT INTO credentials (
        id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag,
        ciphertext, nonce, tag
      ) VALUES (
        '00000000-0000-4000-8000-000000000192', '${foreignWorkspaceId}',
        'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06'
      );
      INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
      VALUES (
        '00000000-0000-4000-8000-000000000193', '${foreignWorkspaceId}', 'x',
        '00000000-0000-4000-8000-000000000192'
      );
      INSERT INTO provider_accounts (
        id, workspace_id, connection_id, provider_account_id, destination_provider,
        remote_account_id, display_name
      ) VALUES (
        '${foreignAccountId}', '${foreignWorkspaceId}',
        '00000000-0000-4000-8000-000000000193', 'foreign-account', 'x',
        'foreign-account', 'Foreign Secret'
      );
      SELECT set_config('app.workspace_id', '${workspaceId}', false);
    `);
    const accounts = await listProviderAccounts(db, workspaceId);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      provider: 'x',
      displayName: 'Example Editorial (@exampleeditorial)',
      status: 'active',
    });
    expect(Object.keys(accounts[0] ?? {})).toEqual([
      'id',
      'provider',
      'grantFamily',
      'destinationProvider',
      'displayName',
      'status',
      'availability',
      'remoteParentAccountId',
      'capabilitiesCheckedAt',
      'adapterDefaults',
      'updatedAt',
      'expiresAt',
      'xLongPosts',
      'capabilitySnapshot',
      'capabilityFreshness',
    ]);
    const principal = {
      id: '00000000-0000-4000-8000-000000000501',
      workspaceId,
      createdByUserId: userId,
      workspaceLabel: 'Credential Workspace',
      prefix: 'pr_test',
      capabilities: ['destinations:read'],
      expiresAt: null,
    };
    const deniedPrincipal = {
      ...principal,
      id: '00000000-0000-4000-8000-000000000502',
      capabilities: [],
    };
    const apiKeys = {
      authenticate: (candidateWorkspaceId: string, token: string) =>
        Promise.resolve(
          candidateWorkspaceId === workspaceId && token === 'test-key'
            ? principal
            : candidateWorkspaceId === workspaceId && token === 'denied-key'
              ? deniedPrincipal
              : null,
        ),
      requireCapability: (candidate: typeof principal, capability: string) =>
        candidate.capabilities.includes(capability)
          ? Promise.resolve()
          : Promise.reject(new ApiKeyAuthorizationError('Missing capability')),
    } as unknown as ApiKeyService;
    const application = Fastify();
    registerDestinationRoutes(
      application,
      db,
      apiKeys,
      new ApiRateLimiter({
        workspace: 1,
        key: 1,
        mutationWorkspace: 1,
        mutationKey: 1,
        windowMs: 60_000,
      }),
    );
    const headers = { authorization: 'Bearer test-key', 'x-publish-relay-workspace': workspaceId };
    expect(
      (await application.inject({ method: 'GET', url: '/api/v1/destinations' })).statusCode,
    ).toBe(401);
    const deniedResponse = await application.inject({
      method: 'GET',
      url: '/api/v1/destinations',
      headers: { ...headers, authorization: 'Bearer denied-key' },
    });
    expect(deniedResponse.statusCode).toBe(403);
    expect(deniedResponse.json()).toMatchObject({
      success: false,
      error: { code: 'missing_capability', message: 'Missing capability' },
    });
    const destinationResponse = await application.inject({
      method: 'GET',
      url: '/api/v1/destinations',
      headers,
    });
    expect(destinationResponse.statusCode).toBe(200);
    const destinationBody = destinationResponse.json<{ data: { items: unknown[] } }>();
    expect(destinationBody.data.items).toEqual([
      {
        id: accounts[0]?.id,
        provider: 'x',
        destinationProvider: 'x',
        displayName: 'Example Editorial (@exampleeditorial)',
        status: 'active',
        availability: 'active',
        remoteParentAccountId: null,
        capabilitySnapshot: {
          schemaVersion: 1,
          contentKinds: ['text'],
          media: { maxImages: 4 },
        },
        capabilitiesCheckedAt: null,
        capabilityFreshness: 'unknown',
        updatedAt: accounts[0]?.updatedAt.toISOString(),
      },
    ]);
    expect(JSON.stringify(destinationBody)).not.toMatch(
      /credentialId|connectionId|adapterDefaults|userId|secret/i,
    );
    expect(JSON.stringify(destinationBody)).not.toContain(foreignAccountId);
    expect(JSON.stringify(destinationBody)).not.toContain('Foreign Secret');
    expect(
      (await application.inject({ method: 'GET', url: '/api/v1/destinations', headers }))
        .statusCode,
    ).toBe(429);
    await application.close();
    const accountId = accounts[0]?.id ?? '';
    expect(
      await updateXLongPostDeclaration(db, {
        workspaceId,
        userId,
        accountId: foreignAccountId,
        requestId: 'req-foreign',
        allowed: true,
      }),
    ).toBe('missing');
    expect(
      (
        await database.query<{ x_long_posts_allowed: boolean }>(
          `select x_long_posts_allowed from provider_accounts where id = '${foreignAccountId}'`,
        )
      ).rows[0]?.x_long_posts_allowed,
    ).toBe(false);
    expect(accounts[0]?.xLongPosts).toEqual({
      allowed: false,
      source: 'self_declared',
      verified: false,
    });
    expect(
      await updateXLongPostDeclaration(db, {
        workspaceId,
        userId,
        accountId,
        requestId: 'req-long-post-enable',
        allowed: true,
      }),
    ).toBe('updated');
    expect((await listProviderAccounts(db, workspaceId))[0]?.xLongPosts).toEqual({
      allowed: true,
      source: 'self_declared',
      verified: false,
    });
    const declarationAudit = await database.query<{
      actor_id: string;
      metadata: { allowed: boolean };
    }>(
      `select actor_id, metadata from audit_events where action = 'provider_account.x_long_posts_declaration_updated'`,
    );
    expect(declarationAudit.rows).toMatchObject([
      { actor_id: userId, metadata: { allowed: true } },
    ]);
    expect(
      await updateXLongPostDeclaration(db, {
        workspaceId,
        userId,
        accountId,
        requestId: 'req-long-post-repeat',
        allowed: true,
      }),
    ).toBe('updated');
    expect(
      (
        await database.query<{ count: number }>(
          `select count(*)::int as count from audit_events where action = 'provider_account.x_long_posts_declaration_updated'`,
        )
      ).rows[0]?.count,
    ).toBe(1);
    await database.exec(`
      INSERT INTO posts (id, workspace_id, created_by_user_id)
      VALUES ('00000000-0000-4000-8000-000000000201', '${workspaceId}', '${userId}');
      INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
      VALUES (
        '00000000-0000-4000-8000-000000000202',
        '${workspaceId}',
        '00000000-0000-4000-8000-000000000201',
        1,
        '{}'
      );
      INSERT INTO publication_jobs (
        id, workspace_id, post_id, revision_id, provider_account_id, state, scheduled_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000203',
        '${workspaceId}',
        '00000000-0000-4000-8000-000000000201',
        '00000000-0000-4000-8000-000000000202',
        '${accountId}',
        'scheduled',
        now()
      );
    `);
    await expect(
      disconnectProviderAccount(db, {
        workspaceId,
        userId,
        accountId,
        requestId: 'req-disconnect-active-account',
      }),
    ).resolves.toBe('scheduled');
    await database.exec(`
      UPDATE publication_jobs
      SET state = 'published'
      WHERE id = '00000000-0000-4000-8000-000000000203';
    `);
    await expect(
      disconnectProviderAccount(db, {
        workspaceId,
        userId,
        accountId,
        requestId: 'req-disconnect-account',
      }),
    ).resolves.toBe('disconnected');
    expect(await listProviderAccounts(db, workspaceId)).toEqual([]);
    const retainedJobs = await database.query<{ count: number }>(
      'select count(*)::int as count from publication_jobs',
    );
    expect(retainedJobs.rows[0]?.count).toBe(1);
    const revoked = await database.query<{ count: number }>(
      'select count(*)::int as count from credentials where revoked_at is not null',
    );
    expect(revoked.rows[0]?.count).toBe(1);
    await connectProvider(
      db,
      keys,
      new FakeProviderConnectionAdapter([
        { providerAccountId: 'external-account', displayName: 'Example Editorial reconnected' },
      ]),
      {
        workspaceId,
        userId,
        provider: 'x',
        externalSubjectId: 'external-account',
        accessToken: 'replacement-secret-token',
        requestId: 'req-reconnect-account',
      },
    );
    const reconnectedAccounts = await listProviderAccounts(db, workspaceId);
    expect(reconnectedAccounts).toHaveLength(1);
    expect(reconnectedAccounts[0]).toMatchObject({
      id: accountId,
      displayName: 'Example Editorial reconnected',
      status: 'active',
      xLongPosts: { allowed: true, source: 'self_declared', verified: false },
    });
    const historyAfterReconnect = await database.query<{ count: number }>(
      'select count(*)::int as count from publication_jobs',
    );
    expect(historyAfterReconnect.rows[0]?.count).toBe(1);
  });

  it('updates only tenant-owned active YouTube destination defaults', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const accountId = '00000000-0000-4000-8000-000000000701';
    await database.exec(`
      INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
        wrapped_key_tag, ciphertext, nonce, tag)
      VALUES ('00000000-0000-4000-8000-000000000702', '${workspaceId}',
        'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
      INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
      VALUES ('00000000-0000-4000-8000-000000000703', '${workspaceId}', 'youtube',
        '00000000-0000-4000-8000-000000000702');
      INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id,
        destination_provider, remote_account_id, display_name)
      VALUES ('${accountId}', '${workspaceId}', '00000000-0000-4000-8000-000000000703',
        'channel-1', 'youtube', 'channel-1', 'Channel One');
    `);
    await expect(
      updateYouTubeAccountDefaults(db, {
        workspaceId,
        userId,
        accountId,
        requestId: 'defaults-1',
        defaults: { privacyStatus: 'public', madeForKids: false, notifySubscribers: true },
      }),
    ).resolves.toBe('updated');
    expect((await listProviderAccounts(db, workspaceId))[0]).toMatchObject({
      id: accountId,
      adapterDefaults: { privacyStatus: 'public', madeForKids: false, notifySubscribers: true },
      xLongPosts: null,
    });
    expect(
      await updateXLongPostDeclaration(db, {
        workspaceId,
        userId,
        accountId,
        requestId: 'req-non-x',
        allowed: true,
      }),
    ).toBe('missing');
    expect(
      (
        await database.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM audit_events
       WHERE action = 'provider_account.defaults_updated' AND target_id = '${accountId}'`,
        )
      ).rows[0]?.count,
    ).toBe(1);
    await database.exec(`UPDATE provider_connections SET status = 'disconnected'
      WHERE id = '00000000-0000-4000-8000-000000000703'`);
    await expect(
      updateYouTubeAccountDefaults(db, {
        workspaceId,
        userId,
        accountId,
        requestId: 'defaults-inactive',
        defaults: {},
      }),
    ).resolves.toBe('missing');
    await database.exec(`UPDATE provider_connections SET status = 'active', provider = 'x'
      WHERE id = '00000000-0000-4000-8000-000000000703'`);
    await expect(
      updateYouTubeAccountDefaults(db, {
        workspaceId,
        userId,
        accountId,
        requestId: 'defaults-wrong-provider',
        defaults: {},
      }),
    ).resolves.toBe('missing');
    await database.exec(`UPDATE provider_connections SET provider = 'youtube';
      UPDATE provider_accounts SET disconnected_at = now() WHERE id = '${accountId}'`);
    await expect(
      updateYouTubeAccountDefaults(db, {
        workspaceId,
        userId,
        accountId,
        requestId: 'defaults-disconnected',
        defaults: {},
      }),
    ).resolves.toBe('missing');
    await expect(
      updateYouTubeAccountDefaults(db, {
        workspaceId,
        userId,
        accountId: '00000000-0000-4000-8000-000000000799',
        requestId: 'defaults-missing',
        defaults: {},
      }),
    ).resolves.toBe('missing');
  });
});
