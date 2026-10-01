import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Fastify from 'fastify';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withTenantTransaction } from '../src/database/tenant-transaction.js';
import { createCredential } from '../src/modules/credentials/credential.repository.js';
import { encryptCredential, type MasterKeyProvider } from '../src/modules/credentials/envelope.js';
import { registerDestinationRoutes } from '../src/modules/credentials/destination.routes.js';
import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import type { ApiKeyService } from '../src/modules/identity/api-key.service.js';
import { TikTokHttpClient } from '../src/modules/providers/tiktok-http-client.js';
import { getUsableTikTokCapabilitySnapshot } from '../src/modules/providers/tiktok-capabilities.service.js';

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
  '0019_media_retention_lifecycle.sql',
  '0045_meta_destination_foundation.sql',
  '0046_linkedin_connection_expiry.sql',
  '0047_linkedin_member_connections.sql',
  '0048_reconcile_linkedin_connections.sql',
  '0049_meta_effective_payload.sql',
  '0051_provider_subject_lifecycle.sql',
  '0052_provider_capability_snapshots.sql',
];
const workspaceId = '00000000-0000-4000-8000-000000000101';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000201';
const userId = '00000000-0000-4000-8000-000000000102';
const accountIds = [
  '00000000-0000-4000-8000-000000000501',
  '00000000-0000-4000-8000-000000000502',
] as const;
const keys: MasterKeyProvider = {
  currentVersion: () => 'test-v1',
  getKey: () => Promise.resolve(Buffer.alloc(32, 7)),
};
let pg: PGlite;
let db: NodePgDatabase;

function creator(nickname: string) {
  return {
    creator_username: nickname.toLowerCase(),
    creator_nickname: nickname,
    creator_avatar_url: 'https://volatile.example/avatar',
    privacy_level_options: ['SELF_ONLY'],
    comment_disabled: false,
    duet_disabled: true,
    stitch_disabled: true,
    max_video_post_duration_sec: 180,
  };
}

function client(fetcher: typeof fetch) {
  return new TikTokHttpClient({
    clientKey: 'fixture-key',
    clientSecret: 'fixture-secret',
    fetch: fetcher,
  });
}

function route(
  clientInstance: TikTokHttpClient,
  workspace = workspaceId,
  credentialKeys: MasterKeyProvider = keys,
) {
  const app = Fastify();
  const principal = {
    id: '00000000-0000-4000-8000-000000000901',
    workspaceId: workspace,
    createdByUserId: userId,
    workspaceLabel: 'Fixture',
    prefix: 'pr_test',
    capabilities: ['destinations:read'],
    expiresAt: null,
  };
  const apiKeys = {
    authenticate: () => Promise.resolve(principal),
    requireCapability: () => Promise.resolve(),
  } as unknown as ApiKeyService;
  registerDestinationRoutes(
    app,
    db,
    apiKeys,
    new ApiRateLimiter({
      workspace: 100,
      key: 100,
      mutationWorkspace: 100,
      mutationKey: 100,
      windowMs: 60_000,
    }),
    undefined,
    { keys: credentialKeys, client: clientInstance },
  );
  return app;
}

function get(app: ReturnType<typeof route>, accountId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/destinations/${accountId}/tiktok-capabilities`,
    headers: { authorization: 'Bearer fixture-key', 'x-publish-relay-workspace': workspaceId },
  });
}

beforeEach(async () => {
  pg = new PGlite();
  for (const migration of migrations)
    await pg.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  db = drizzle(pg) as unknown as NodePgDatabase;
  await pg.exec(`
    INSERT INTO workspaces (id, name, slug) VALUES
      ('${workspaceId}', 'One', 'one'), ('${otherWorkspaceId}', 'Two', 'two');
    INSERT INTO users (id, email, password_hash) VALUES ('${userId}', 'owner@example.test', 'redacted');
    SELECT set_config('app.workspace_id', '${workspaceId}', false);
    INSERT INTO memberships (workspace_id, user_id, role) VALUES ('${workspaceId}', '${userId}', 'owner');
  `);
  for (const [index, accountId] of accountIds.entries()) {
    const subject = `subject-${String(index + 1)}`;
    const token = {
      access_token: `access-${String(index + 1)}`,
      refresh_token: `refresh-${String(index + 1)}`,
      open_id: subject,
      scope: 'video.publish',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_expires_in: 3600,
    };
    const encrypted = await encryptCredential(Buffer.from(JSON.stringify(token)), keys);
    const credential = await withTenantTransaction(db, { workspaceId }, (transaction) =>
      createCredential(transaction, workspaceId, encrypted),
    );
    await pg.exec(`
      INSERT INTO provider_connections (id, workspace_id, provider, external_subject_id, credential_id,
        scopes, access_expires_at, refresh_expires_at)
      VALUES ('00000000-0000-4000-8000-00000000060${String(index + 1)}', '${workspaceId}', 'tiktok', '${subject}',
        '${credential.id}', '["video.publish"]', now() + interval '1 hour', now() + interval '1 day');
      INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id,
        destination_provider, remote_account_id, display_name)
      VALUES ('${accountId}', '${workspaceId}', '00000000-0000-4000-8000-00000000060${String(index + 1)}',
        '${subject}', 'tiktok', '${subject}', '${subject}');
    `);
  }
});
afterEach(async () => pg.close());

describe('TikTok creator capability snapshots', () => {
  it('stores separate immutable subject snapshots and returns only bounded fields', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      const subject =
        init?.headers &&
        (init.headers as Record<string, string>).authorization?.endsWith('access-1')
          ? 'One'
          : 'Two';
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: creator(subject), error: { code: 'ok', log_id: 'safe-log' } }),
          { status: 200 },
        ),
      );
    });
    const app = route(client(fetcher));
    const first = await get(app, accountIds[0]);
    const second = await get(app, accountIds[1]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const one = first.json<{ data: Record<string, unknown> }>().data;
    const two = second.json<{ data: Record<string, unknown> }>().data;
    expect(one).toMatchObject({
      nickname: 'One',
      privacyOptions: ['SELF_ONLY'],
      duetDisabled: true,
    });
    expect(two).toMatchObject({ nickname: 'Two', privacyOptions: ['SELF_ONLY'] });
    expect(one.id).not.toBe(two.id);
    expect(first.body.length).toBeLessThan(1024);
    await expect(
      getUsableTikTokCapabilitySnapshot(db, {
        workspaceId,
        accountId: accountIds[0],
        snapshotId: String(one.id),
      }),
    ).resolves.toMatchObject({ nickname: 'One' });
    await expect(
      getUsableTikTokCapabilitySnapshot(db, {
        workspaceId,
        accountId: accountIds[0],
        snapshotId: String(one.id),
        now: new Date(Date.now() + 16 * 60_000),
      }),
    ).rejects.toThrow('unavailable');
    await expect(
      getUsableTikTokCapabilitySnapshot(db, {
        workspaceId,
        accountId: accountIds[1],
        snapshotId: String(one.id),
      }),
    ).rejects.toThrow('unavailable');
    expect(JSON.stringify([one, two])).not.toMatch(
      /avatar|logId|credential|secret|privacyDefault/i,
    );
    const rows = await pg.query<{ external_subject_id: string; provider_log_id: string }>(
      'SELECT external_subject_id, provider_log_id FROM provider_capability_snapshots ORDER BY external_subject_id',
    );
    expect(rows.rows).toEqual([
      { external_subject_id: 'subject-1', provider_log_id: 'safe-log' },
      { external_subject_id: 'subject-2', provider_log_id: 'safe-log' },
    ]);
    await pg.exec(`CREATE ROLE snapshot_reader NOLOGIN NOBYPASSRLS;
      GRANT SELECT, INSERT ON provider_capability_snapshots TO snapshot_reader;
      SELECT set_config('app.workspace_id', '${otherWorkspaceId}', false);
      SET ROLE snapshot_reader;`);
    expect((await pg.query('SELECT id FROM provider_capability_snapshots')).rows).toHaveLength(0);
    await expect(
      pg.exec(`INSERT INTO provider_capability_snapshots
      (workspace_id, account_id, connection_id, external_subject_id, credential_version,
       nickname, privacy_options, comment_disabled, duet_disabled, stitch_disabled,
       max_video_duration_seconds, fetched_at, expires_at)
      VALUES ('${workspaceId}', '${accountIds[0]}', '00000000-0000-4000-8000-000000000601',
        'subject-1', 1, 'denied', '["SELF_ONLY"]', false, false, false, 1,
        now(), now() + interval '1 minute')`),
    ).rejects.toThrow();
    await pg.exec('RESET ROLE');
    await app.close();
  });

  it('rejects cross-tenant, expired, revoked and rotated grants without returning stale choices', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: creator('One'), error: { code: 'ok' } }), {
        status: 200,
      }),
    );
    const app = route(client(fetcher));
    const other = route(client(fetcher), otherWorkspaceId);
    expect((await get(other, accountIds[0])).statusCode).toBe(409);
    const initial = await get(app, accountIds[0]);
    expect(initial.statusCode).toBe(200);
    const snapshotId = initial.json<{ data: { id: string } }>().data.id;
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429 }),
    );
    const failedRefresh = await get(app, accountIds[0]);
    expect(failedRefresh.statusCode).toBe(429);
    expect(failedRefresh.body).not.toContain(snapshotId);
    await pg.exec(
      `UPDATE provider_connections SET refresh_expires_at = now() - interval '1 minute' WHERE external_subject_id = 'subject-1'`,
    );
    expect((await get(app, accountIds[0])).statusCode).toBe(409);
    await expect(
      getUsableTikTokCapabilitySnapshot(db, { workspaceId, accountId: accountIds[0], snapshotId }),
    ).rejects.toThrow('unavailable');
    await pg.exec(
      `UPDATE provider_connections SET refresh_expires_at = now() + interval '1 day', revoked_at = now() WHERE external_subject_id = 'subject-1'`,
    );
    expect((await get(app, accountIds[0])).statusCode).toBe(409);
    await pg.exec(
      `UPDATE provider_connections SET revoked_at = null WHERE external_subject_id = 'subject-1'`,
    );
    const rotating = client(
      vi.fn<typeof fetch>().mockImplementation(async () => {
        await pg.exec(
          `UPDATE credentials SET version = version + 1 WHERE id = (SELECT credential_id FROM provider_connections WHERE external_subject_id = 'subject-1')`,
        );
        return new Response(JSON.stringify({ data: creator('One'), error: { code: 'ok' } }), {
          status: 200,
        });
      }),
    );
    const rotated = route(rotating);
    expect((await get(rotated, accountIds[0])).statusCode).toBe(409);
    await expect(
      getUsableTikTokCapabilitySnapshot(db, { workspaceId, accountId: accountIds[0], snapshotId }),
    ).rejects.toThrow('unavailable');
    expect((await pg.query('SELECT id FROM provider_capability_snapshots')).rows).toHaveLength(1);
    await app.close();
    await other.close();
    await rotated.close();
  });

  it('fails closed for malformed creator data and provider rate/auth failures', async () => {
    for (const [body, status, expected] of [
      [{ data: { creator_nickname: 'Partial' }, error: { code: 'ok' } }, 200, 502],
      [{ data: creator('N'.repeat(4096)), error: { code: 'ok' } }, 200, 502],
      [
        {
          data: { ...creator('One'), privacy_level_options: Array(100).fill('SELF_ONLY') },
          error: { code: 'ok' },
        },
        200,
        502,
      ],
      [
        {
          data: { ...creator('One'), privacy_level_options: ['SELF_ONLY', 'SELF_ONLY'] },
          error: { code: 'ok' },
        },
        200,
        502,
      ],
      [{ error: { code: 'rate_limit_exceeded', log_id: 'safe-log' } }, 429, 429],
      [{ error: { code: 'access_token_invalid', log_id: 'safe-log' } }, 401, 409],
    ] as const) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(body), { status }));
      const app = route(client(fetcher));
      const response = await get(app, accountIds[0]);
      expect(response.statusCode).toBe(expected);
      expect(response.body).not.toMatch(/access-1|safe-log|avatar/i);
      await app.close();
    }
    expect((await pg.query('SELECT id FROM provider_capability_snapshots')).rows).toHaveLength(0);
  });

  it('rejects rotation between token decryption and version lookup before provider fetch', async () => {
    let rotated = false;
    const rotatingKeys: MasterKeyProvider = {
      currentVersion: () => keys.currentVersion(),
      getKey: async (version) => {
        if (!rotated) {
          rotated = true;
          await pg.exec(`UPDATE credentials SET version = version + 1 WHERE id =
            (SELECT credential_id FROM provider_connections WHERE external_subject_id = 'subject-1')`);
        }
        return keys.getKey(version);
      },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: creator('One'), error: { code: 'ok' } }), {
        status: 200,
      }),
    );
    const app = route(client(fetcher), workspaceId, rotatingKeys);
    expect((await get(app, accountIds[0])).statusCode).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await pg.query('SELECT id FROM provider_capability_snapshots')).rows).toHaveLength(0);
    await app.close();
  });
});

it.each(['fresh', 'upgrade'] as const)(
  'applies %s PostgreSQL migration and then no-ops',
  async (mode) => {
    const fresh = new PGlite();
    try {
      await fresh.exec(`CREATE SCHEMA drizzle;
      CREATE TABLE drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);`);
      const journal = readMigrationFiles({ migrationsFolder: 'migrations' });
      async function applyPending(through = Number.POSITIVE_INFINITY) {
        const ledger = await fresh.query<{ created_at: string }>(
          'SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1',
        );
        const last = Number(ledger.rows[0]?.created_at ?? 0);
        for (const migration of journal.filter(
          (item) => item.folderMillis > last && item.folderMillis <= through,
        )) {
          for (const statement of migration.sql) await fresh.exec(statement);
          await fresh.query(
            'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
            [migration.hash, migration.folderMillis],
          );
        }
      }
      if (mode === 'upgrade') {
        const previous = journal.at(-2);
        if (!previous) throw new Error('Previous migration missing');
        await applyPending(previous.folderMillis);
        const absent = await fresh.query(
          "SELECT to_regclass('public.provider_capability_snapshots') AS table_name",
        );
        expect(absent.rows[0]).toEqual({ table_name: null });
      }
      await applyPending();
      const first = await fresh.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
      );
      expect(Number(first.rows[0]?.count)).toBe(journal.length);
      await applyPending();
      const second = await fresh.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
      );
      expect(second.rows[0]?.count).toBe(first.rows[0]?.count);
      expect(
        (
          await fresh.query(
            "SELECT to_regclass('public.provider_capability_snapshots') AS table_name",
          )
        ).rows[0],
      ).toEqual({ table_name: 'provider_capability_snapshots' });
    } finally {
      await fresh.close();
    }
  },
);
