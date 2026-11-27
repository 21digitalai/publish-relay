import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { z } from 'zod';

const migrationConfig = z.object({
  DATABASE_URL: z.url().startsWith('postgresql://'),
});

async function runMigrations(): Promise<void> {
  const config = migrationConfig.parse(process.env);
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
  try {
    if (process.env.PUBLISH_RELAY_MIGRATION_TRANSITION) {
      const { assertKnownHistoryTransition, assertKnownHistoryLedger, assertKnownHistorySchema } =
        await import('../../deploy/known-history-transition.mjs');
      assertKnownHistoryTransition(
        process.env.PUBLISH_RELAY_MIGRATION_SOURCE,
        process.cwd(),
        process.env.PUBLISH_RELAY_MIGRATION_TRANSITION,
      );
      const ledger = await pool.query<{ hash: string; created_at: string }>(
        'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
      );
      assertKnownHistoryLedger(ledger.rows);
      await assertKnownHistorySchema(pool, ledger.rows);
    }
    await migrate(drizzle(pool), { migrationsFolder: 'migrations' });
  } finally {
    await pool.end();
  }
}

await runMigrations();
