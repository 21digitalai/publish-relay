import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

const migrationsFolder = 'migrations';
const META_TIMESTAMP = 1790857500000;
const RECONCILIATION_TIMESTAMP = 1790857500001;
const META_PAYLOAD_TIMESTAMP = 1790862000000;
const INSTAGRAM_TIMESTAMP = 1790862000001;

async function applyPending(database: PGlite, through = META_PAYLOAD_TIMESTAMP): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });
  const ledger = await database.query<{ created_at: string }>(
    'SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1',
  );
  const lastApplied = Number(ledger.rows[0]?.created_at ?? 0);
  for (const migration of migrations.filter(
    (item) => item.folderMillis > lastApplied && item.folderMillis <= through,
  )) {
    for (const statement of migration.sql) await database.exec(statement);
    await database.query(
      'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
      [migration.hash, migration.folderMillis],
    );
  }
}

async function createPostMetaFixture(database: PGlite): Promise<void> {
  await database.exec(`
    CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
    CREATE TABLE public.provider_connections (id uuid primary key, workspace_id uuid not null, provider text not null);
    CREATE UNIQUE INDEX provider_connections_workspace_provider_unique ON public.provider_connections (workspace_id, provider);
    CREATE TABLE public.provider_accounts (connection_id uuid not null, provider_account_id text not null, destination_provider text not null);
    CREATE TABLE public.publication_jobs (id uuid primary key);
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('post-0045', 1790857500000);
    INSERT INTO public.provider_connections VALUES
      ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000201', 'x'),
      ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000201', 'youtube'),
      ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000201', 'meta'),
      ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000201', 'linkedin');
    INSERT INTO public.provider_accounts VALUES
      ('00000000-0000-4000-8000-000000000103', 'page-1', 'facebook_page'),
      ('00000000-0000-4000-8000-000000000104', 'urn:li:person:one', 'linkedin');
  `);
}

async function expectReconciled(database: PGlite): Promise<void> {
  const columns = await database.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'provider_connections'
    AND column_name IN ('expires_at', 'member_urn') ORDER BY column_name`);
  expect(columns.rows.map((row) => row.column_name)).toEqual(['expires_at', 'member_urn']);

  const connections = await database.query<{ provider: string; member_urn: string | null }>(
    'SELECT provider, member_urn FROM public.provider_connections ORDER BY provider',
  );
  expect(connections.rows).toEqual([
    { provider: 'linkedin', member_urn: 'urn:li:person:one' },
    { provider: 'meta', member_urn: null },
    { provider: 'x', member_urn: null },
    { provider: 'youtube', member_urn: null },
  ]);
  const accounts = await database.query<{ destination_provider: string }>(
    'SELECT destination_provider FROM public.provider_accounts ORDER BY destination_provider',
  );
  expect(accounts.rows.map((row) => row.destination_provider)).toEqual([
    'facebook_page',
    'linkedin',
  ]);

  const indexes = await database.query<{ indexname: string; indexdef: string }>(`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
    AND indexname IN ('provider_connections_workspace_provider_unique', 'provider_connections_linkedin_member_unique')
    ORDER BY indexname`);
  expect(indexes.rows).toHaveLength(2);
  expect(
    indexes.rows.find((row) => row.indexname === 'provider_connections_workspace_provider_unique')
      ?.indexdef,
  ).toContain("provider <> 'linkedin'");
  const constraint = await database.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM pg_constraint
    WHERE conrelid = 'public.provider_connections'::regclass
    AND conname = 'provider_connections_linkedin_member_required'`);
  expect(constraint.rows[0]?.count).toBe('1');
}

describe('LinkedIn migration chronology', () => {
  it('applies the full journal on a fresh database', async () => {
    const database = new PGlite();
    try {
      await database.exec(`CREATE SCHEMA drizzle;
        CREATE TABLE drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);`);
      await applyPending(database, INSTAGRAM_TIMESTAMP);
      const ledger = await database.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
      );
      expect(Number(ledger.rows[0]?.count)).toBe(readMigrationFiles({ migrationsFolder }).length);
    } finally {
      await database.close();
    }
  });

  it.each(['skipped', 'fully-migrated'] as const)(
    'reconciles a post-0045 %s 0.1.14 database exactly once',
    async (fixture) => {
      const migrations = readMigrationFiles({ migrationsFolder });
      expect(migrations.at(-1)?.folderMillis).toBe(INSTAGRAM_TIMESTAMP);
      expect(
        migrations.find((item) => item.folderMillis === RECONCILIATION_TIMESTAMP),
      ).toBeDefined();
      expect(migrations.find((item) => item.folderMillis === META_TIMESTAMP)).toBeDefined();
      const database = new PGlite();
      try {
        await createPostMetaFixture(database);
        if (fixture === 'fully-migrated') {
          for (const tag of [
            '0046_linkedin_connection_expiry',
            '0047_linkedin_member_connections',
          ]) {
            const sql = await readFile(
              new URL(`../migrations/${tag}.sql`, import.meta.url),
              'utf8',
            );
            await database.exec(sql);
          }
          await database.exec(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES
            ('historical-0046', 1790578817310), ('historical-0047', 1790580000000);`);
        }
        await applyPending(database);
        await applyPending(database);
        await expectReconciled(database);
        const ledger = await database.query<{ created_at: string }>(
          'SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at',
        );
        expect(ledger.rows.map((row) => Number(row.created_at))).toEqual(
          fixture === 'skipped'
            ? [META_TIMESTAMP, RECONCILIATION_TIMESTAMP, META_PAYLOAD_TIMESTAMP]
            : [
                1790578817310,
                1790580000000,
                META_TIMESTAMP,
                RECONCILIATION_TIMESTAMP,
                META_PAYLOAD_TIMESTAMP,
              ],
        );
      } finally {
        await database.close();
      }
    },
  );
});
