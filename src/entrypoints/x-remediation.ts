#!/usr/bin/env node
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { loadRuntimeConfig } from '../config/runtime-config.js';
import { RuntimeMasterKeyProvider } from '../config/runtime-master-keys.js';
import { withTenantTransaction } from '../database/tenant-transaction.js';
import { decryptCredential } from '../modules/credentials/envelope.js';
import { getActiveCredential } from '../modules/credentials/credential.repository.js';
import { XHttpClient } from '../modules/providers/x-http-client.js';
import { loadRemediationSource } from '../modules/providers/x-remediation.repository.js';
import {
  DAILY_VIBER_REMEDIATION,
  dryRunDailyViberRemediation,
  type XRemediationGateway,
} from '../modules/providers/x-remediation.service.js';

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} is required`);
  return value;
}

async function credentialId(database: NodePgDatabase, workspaceId: string): Promise<string> {
  const jobId = DAILY_VIBER_REMEDIATION[0][0];
  return withTenantTransaction(database, { workspaceId }, async (transaction) => {
    const result = await transaction.execute<{ credentialId: string }>(sql`
      SELECT connection.credential_id AS "credentialId"
      FROM publication_jobs job
      JOIN provider_accounts account ON account.workspace_id = job.workspace_id
        AND account.id = job.provider_account_id
      JOIN provider_connections connection ON connection.workspace_id = account.workspace_id
        AND connection.id = account.connection_id
      WHERE job.workspace_id = ${workspaceId} AND job.id = ${jobId}
        AND connection.provider = 'x'
    `);
    const row = (Array.isArray(result) ? result : result.rows)[0];
    if (!row) throw new Error('Allowlisted X credential was not found');
    return row.credentialId;
  });
}

async function main(): Promise<void> {
  if (process.argv[2] !== 'dry-run')
    throw new Error('Only dry-run is available before Oracle approval');
  const workspaceId = argument('workspace-id');
  const config = loadRuntimeConfig();
  if (!config.DATABASE_URL || !config.PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION)
    throw new Error('Database and master-key configuration are required');
  const consumerKey = config.PUBLISH_RELAY_X_CONSUMER_KEY ?? config.X_API_KEY;
  const consumerSecret = config.PUBLISH_RELAY_X_CONSUMER_SECRET ?? config.X_API_SECRET;
  if (!consumerKey || !consumerSecret) throw new Error('X consumer credentials are required');
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    options: '-c role=publish_relay_web',
    max: 1,
  });
  const database = drizzle(pool);
  try {
    const id = await credentialId(database, workspaceId);
    const stored = await withTenantTransaction(database, { workspaceId }, (transaction) =>
      getActiveCredential(transaction, workspaceId, id),
    );
    if (!stored) throw new Error('Allowlisted X credential is unavailable');
    const plaintext = await decryptCredential(
      stored,
      new RuntimeMasterKeyProvider(config.PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION),
    );
    try {
      const client = new XHttpClient({ consumerKey, consumerSecret }).bindCredential(
        plaintext.toString('utf8'),
      );
      const gateway = {
        loadSource: (jobId: string, externalPostId: string) =>
          loadRemediationSource(database, workspaceId, jobId, externalPostId),
        lookup: (externalPostId: string) => client.getPost(externalPostId),
      } as XRemediationGateway;
      const result = await dryRunDailyViberRemediation(gateway);
      process.stdout.write(JSON.stringify({ success: true, dryRun: true, items: result }) + '\n');
    } finally {
      plaintext.fill(0);
    }
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write('X remediation dry-run failed\n');
  process.exitCode = 1;
});
