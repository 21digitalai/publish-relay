import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

const migrationsFolder = 'migrations';

async function applyPending(database: PGlite): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });
  const ledger = await database.query<{ created_at: string }>(
    'SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1',
  );
  const lastApplied = Number(ledger.rows[0]?.created_at ?? 0);
  for (const migration of migrations.filter((item) => item.folderMillis > lastApplied)) {
    for (const statement of migration.sql) await database.exec(statement);
    await database.query(
      'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
      [migration.hash, migration.folderMillis],
    );
  }
}

describe('LinkedIn migration chronology', () => {
  it('applies the full journal on a fresh database', async () => {
    const database = new PGlite();
    try {
      await database.exec(`CREATE SCHEMA drizzle;
        CREATE TABLE drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);`);
      await applyPending(database);
      const ledger = await database.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
      );
      expect(Number(ledger.rows[0]?.count)).toBe(readMigrationFiles({ migrationsFolder }).length);
    } finally {
      await database.close();
    }
  });

  it('advances a post-0045 ledger exactly once without changing existing destinations', async () => {
    const migrations = readMigrationFiles({ migrationsFolder });
    expect(
      migrations.every(
        (migration, index) =>
          index === 0 || migration.folderMillis > (migrations[index - 1]?.folderMillis ?? 0),
      ),
    ).toBe(true);
    const database = new PGlite();
    try {
      await database.exec(`
        CREATE SCHEMA drizzle;
        CREATE TABLE drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
        CREATE TABLE public.provider_connections (id uuid primary key, workspace_id uuid not null, provider text not null);
        CREATE UNIQUE INDEX provider_connections_workspace_provider_unique ON public.provider_connections (workspace_id, provider);
        CREATE TABLE public.provider_accounts (connection_id uuid not null, provider_account_id text not null, destination_provider text not null);
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('post-0045', 1790857500000);
        INSERT INTO public.provider_connections VALUES
          ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000201', 'x'),
          ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000201', 'youtube'),
          ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000201', 'meta');
        INSERT INTO public.provider_accounts VALUES
          ('00000000-0000-4000-8000-000000000103', 'page-1', 'facebook_page');
      `);
      await applyPending(database);
      await applyPending(database);
      const columns = await database.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'provider_connections'
        AND column_name IN ('expires_at', 'member_urn') ORDER BY column_name`);
      expect(columns.rows.map((row) => row.column_name)).toEqual(['expires_at', 'member_urn']);
      const ledger = await database.query<{ created_at: string }>(
        'SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at',
      );
      expect(ledger.rows.map((row) => Number(row.created_at))).toEqual([
        1790857500000, 1790857500001, 1790857500002,
      ]);
      const destinations = await database.query<{ destination_provider: string }>(
        'SELECT destination_provider FROM public.provider_accounts',
      );
      expect(destinations.rows).toEqual([{ destination_provider: 'facebook_page' }]);
    } finally {
      await database.close();
    }
  });
});
