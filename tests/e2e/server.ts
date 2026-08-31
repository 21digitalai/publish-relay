import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createApplication } from '../../src/application/create-application.js';
import { createPostgresAuthStore } from '../../src/modules/identity/auth.repository.js';
import { AuthService } from '../../src/modules/identity/auth.service.js';

const database = new PGlite();
const migrationNames = (await readdir(new URL('../../migrations/', import.meta.url)))
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort();
for (const name of migrationNames)
  await database.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
await database.exec(`
  CREATE ROLE publish_relay_app NOLOGIN;
  GRANT USAGE ON SCHEMA public TO publish_relay_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO publish_relay_app;
`);
const application = createApplication(
  { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 43199, WORKER_POLL_INTERVAL_MS: 1000 },
  new AuthService(createPostgresAuthStore(drizzle(database) as unknown as NodePgDatabase)),
  undefined,
  resolve(process.cwd(), 'dist/ui'),
);
application.addHook('onClose', async () => database.close());
await application.listen({ host: '127.0.0.1', port: 43199 });
