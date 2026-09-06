#!/usr/bin/env node
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { loadRuntimeConfig, resolveWorkerDatabaseUrl } from '../config/runtime-config.js';
import { RuntimeMasterKeyProvider } from '../config/runtime-master-keys.js';
import { withTenantTransaction } from '../database/tenant-transaction.js';
import { decryptCredential } from '../modules/credentials/envelope.js';
import { getActiveCredential } from '../modules/credentials/credential.repository.js';
import { XHttpClient } from '../modules/providers/x-http-client.js';
import {
  createLocalXMediaSource,
  createXMediaClientFactory,
  dispatchDueXJobs,
} from '../modules/providers/x-media-dispatch.service.js';
import {
  loadRemediationSource,
  XRemediationJournalRepository,
} from '../modules/providers/x-remediation.repository.js';
import {
  DAILY_VIBER_REMEDIATION,
  executeDailyViberCanary,
  LIVE_CONFIRMATION,
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
  const id = await withTenantTransaction(database, { workspaceId }, async (transaction) => {
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
    const rows = (Array.isArray(result) ? result : result.rows) as { credentialId: string }[];
    const row = rows[0];
    if (!row) throw new Error('Allowlisted X credential was not found');
    return row.credentialId;
  });
  return id;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'dry-run' && command !== 'live-canary')
    throw new Error('Unknown remediation mode');
  const workspaceId = argument('workspace-id');
  if (command === 'live-canary') {
    if (argument('job-id') !== DAILY_VIBER_REMEDIATION[0][0])
      throw new Error('Job is not allowlisted');
    if (argument('post-id') !== DAILY_VIBER_REMEDIATION[0][1])
      throw new Error('Post is not allowlisted');
    if (argument('confirmation') !== LIVE_CONFIRMATION)
      throw new Error('Live confirmation is invalid');
  }
  const config = loadRuntimeConfig();
  if (!config.DATABASE_URL || !config.PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION)
    throw new Error('Database and master-key configuration are required');
  if (command === 'live-canary' && !config.MEDIA_STORAGE_ROOT)
    throw new Error('Media storage configuration is required for live canary');
  const masterKeyVersion = config.PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION;
  const mediaStorageRoot = config.MEDIA_STORAGE_ROOT;
  const consumerKey = config.PUBLISH_RELAY_X_CONSUMER_KEY ?? config.X_API_KEY;
  const consumerSecret = config.PUBLISH_RELAY_X_CONSUMER_SECRET ?? config.X_API_SECRET;
  if (!consumerKey || !consumerSecret) throw new Error('X consumer credentials are required');
  const pool = new pg.Pool({
    connectionString:
      command === 'live-canary' ? resolveWorkerDatabaseUrl(config) : config.DATABASE_URL,
    options:
      command === 'live-canary' ? '-c role=publish_relay_worker' : '-c role=publish_relay_web',
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
      const journal = new XRemediationJournalRepository(database, workspaceId);
      const gateway: XRemediationGateway = {
        loadSource: (jobId: string, externalPostId: string) =>
          loadRemediationSource(database, workspaceId, jobId, externalPostId),
        lookup: (externalPostId: string) => client.getPost(externalPostId),
        readJournal: (jobId: string) => journal.read(jobId),
        prepareJournal: (value: Parameters<typeof journal.prepare>[0]) => journal.prepare(value),
        markDeleteStarted: (jobId: string) => journal.markDeleteStarted(jobId),
        markDeleted: (jobId: string) => journal.markDeleted(jobId),
        deletePost: (externalPostId: string) => client.deletePost(externalPostId),
        markReplacementStarted: (jobId: string) => journal.markReplacementStarted(jobId),
        prepareReplacement: (source: Awaited<ReturnType<typeof loadRemediationSource>>) =>
          journal.prepareReplacement(source),
        markReplaced: (jobId: string, replacement: Parameters<typeof journal.markReplaced>[1]) =>
          journal.markReplaced(jobId, replacement),
        markVerified: (jobId: string) => journal.markVerified(jobId),
        publishReplacement: async (_source, replacementJobId) => {
          const publishedAttempt = async () => {
            const result = await withTenantTransaction(database, { workspaceId }, (transaction) =>
              transaction.execute<{ attemptId: string; externalPostId: string }>(sql`
                SELECT id AS "attemptId", external_post_id AS "externalPostId"
                FROM publication_attempts WHERE workspace_id = ${workspaceId}
                  AND job_id = ${replacementJobId} AND outcome = 'published'
                ORDER BY attempt_number DESC LIMIT 1
              `),
            );
            return result.rows[0];
          };
          const existingAttempt = await publishedAttempt();
          if (existingAttempt?.externalPostId)
            return {
              jobId: replacementJobId,
              attemptId: existingAttempt.attemptId,
              externalPostId: existingAttempt.externalPostId,
              externalUrl: `https://x.com/TheDailyViber/status/${existingAttempt.externalPostId}`,
            };
          const dispatched = await dispatchDueXJobs(
            {
              database,
              keys: new RuntimeMasterKeyProvider(masterKeyVersion),
              source: createLocalXMediaSource(database, mediaStorageRoot ?? ''),
              createClient: createXMediaClientFactory({ consumerKey, consumerSecret }),
              workerId: 'x-remediation-canary',
              leaseMs: 60_000,
            },
            new Date(),
            { workspaceId, jobId: replacementJobId },
          );
          if (dispatched !== 1) throw new Error('Exact replacement job was not dispatched');
          const attempt = await publishedAttempt();
          if (!attempt?.externalPostId) throw new Error('Replacement publish did not complete');
          return {
            jobId: replacementJobId,
            attemptId: attempt.attemptId,
            externalPostId: attempt.externalPostId,
            externalUrl: `https://x.com/TheDailyViber/status/${attempt.externalPostId}`,
          };
        },
      };
      const result =
        command === 'dry-run'
          ? await dryRunDailyViberRemediation(gateway)
          : await executeDailyViberCanary(gateway, {
              confirmation: argument('confirmation'),
              jobId: argument('job-id'),
              externalPostId: argument('post-id'),
            });
      process.stdout.write(JSON.stringify({ success: true, mode: command, result }) + '\n');
    } finally {
      plaintext.fill(0);
    }
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write('X remediation failed\n');
  process.exitCode = 1;
});
