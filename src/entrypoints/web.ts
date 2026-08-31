import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { createApplication } from '../application/create-application.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { createPostgresAuthStore } from '../modules/identity/auth.repository.js';
import { AuthService } from '../modules/identity/auth.service.js';
import { createPostgresApiKeyStore } from '../modules/identity/api-key.repository.js';
import { ApiKeyService } from '../modules/identity/api-key.service.js';

const config = loadRuntimeConfig();
if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required for the web process');
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const database = drizzle(pool);
const application = createApplication(
  config,
  new AuthService(createPostgresAuthStore(database)),
  new ApiKeyService(createPostgresApiKeyStore(database)),
);
application.addHook('onClose', async () => pool.end());

await application.listen({ host: config.HOST, port: config.PORT });
