#!/usr/bin/env node
import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { loadRuntimeConfig } from '../config/runtime-config.js';
import { RuntimeMasterKeyProvider } from '../config/runtime-master-keys.js';
import { XHttpClient } from '../modules/providers/x-http-client.js';
import { importLegacyXCredential } from '../modules/providers/x-legacy-credential-import.js';

function argument(name: string): string {
  const index = process.argv.indexOf('--' + name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('--' + name + ' is required');
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks).toString('utf8');
}

const config = loadRuntimeConfig();
if (!config.DATABASE_URL || !config.PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION)
  throw new Error('Database and master-key configuration are required');
const consumerKey = config.PUBLISH_RELAY_X_CONSUMER_KEY ?? config.X_API_KEY;
const consumerSecret = config.PUBLISH_RELAY_X_CONSUMER_SECRET ?? config.X_API_SECRET;
if (!consumerKey || !consumerSecret) throw new Error('X consumer credentials are required');
const credentialValue = await readStdin();
const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  options: '-c role=publish_relay_web',
  max: 1,
});
try {
  const result = await importLegacyXCredential(
    drizzle(pool),
    new RuntimeMasterKeyProvider(config.PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION),
    new XHttpClient({ consumerKey, consumerSecret }),
    {
      workspaceId: argument('workspace-id'),
      userId: argument('user-id'),
      sourceIntegrationId: argument('source-integration-id'),
      expectedUsername: argument('expected-username'),
      credentialValue,
      requestId: randomUUID(),
    },
  );
  process.stdout.write(JSON.stringify({ success: true, data: result }) + '\\n');
} finally {
  await pool.end();
}
