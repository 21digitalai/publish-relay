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
    await migrate(drizzle(pool), { migrationsFolder: 'migrations' });
  } finally {
    await pool.end();
  }
}

await runMigrations();
