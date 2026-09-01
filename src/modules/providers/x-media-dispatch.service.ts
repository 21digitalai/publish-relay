import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  mediaObjects,
  providerAccounts,
  providerConnections,
  publicationJobs,
  revisionMedia,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { getActiveCredential } from '../credentials/credential.repository.js';
import { decryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
import { claimDueJobs, startDispatchAttempt } from '../scheduler/job.repository.js';
import { XHttpClient, type XHttpClientOptions } from './x-http-client.js';
import {
  stageXMedia,
  type XMediaSource,
  type XMediaUploadClient,
} from './x-media-staging.service.js';

export interface XMediaDispatchInput {
  workspaceId: string;
  jobId: string;
  credential: string;
  mediaIds: readonly string[];
  idempotencyKey: string;
}

export type XMediaClientFactory = (credential: string) => XMediaUploadClient;

export interface XDispatchRuntime {
  database: NodePgDatabase;
  keys: MasterKeyProvider;
  source: XMediaSource;
  createClient: XMediaClientFactory;
  workerId: string;
  leaseMs: number;
}

export function createLocalXMediaSource(
  database: NodePgDatabase,
  storageRoot: string,
): XMediaSource {
  const root = resolve(storageRoot);
  return {
    async load(input) {
      const rows = await withTenantTransaction(database, input, (transaction) =>
        transaction
          .select({ storageKey: mediaObjects.storageKey, mimeType: mediaObjects.mimeType })
          .from(mediaObjects)
          .where(
            and(
              eq(mediaObjects.workspaceId, input.workspaceId),
              eq(mediaObjects.id, input.mediaId),
            ),
          )
          .limit(1),
      );
      const media = rows[0];
      if (!media) throw new Error('Scheduled media is unavailable');
      const path = resolve(root, media.storageKey);
      if (path !== root && !path.startsWith(`${root}${sep}`))
        throw new Error('Scheduled media path is invalid');
      return { bytes: await readFile(path), mimeType: media.mimeType };
    },
  };
}

async function loadXJobContext(database: NodePgDatabase, workspaceId: string, jobId: string) {
  return withTenantTransaction(database, { workspaceId }, async (transaction) => {
    const rows = await transaction
      .select({
        credentialId: providerConnections.credentialId,
        mediaId: revisionMedia.mediaId,
      })
      .from(publicationJobs)
      .innerJoin(
        providerAccounts,
        and(
          eq(providerAccounts.workspaceId, publicationJobs.workspaceId),
          eq(providerAccounts.id, publicationJobs.providerAccountId),
        ),
      )
      .innerJoin(
        providerConnections,
        and(
          eq(providerConnections.workspaceId, publicationJobs.workspaceId),
          eq(providerConnections.id, providerAccounts.connectionId),
        ),
      )
      .leftJoin(
        revisionMedia,
        and(
          eq(revisionMedia.workspaceId, publicationJobs.workspaceId),
          eq(revisionMedia.revisionId, publicationJobs.revisionId),
        ),
      )
      .where(
        and(
          eq(publicationJobs.workspaceId, workspaceId),
          eq(publicationJobs.id, jobId),
          eq(providerConnections.provider, 'x'),
        ),
      )
      .orderBy(asc(revisionMedia.position));
    if (rows.length === 0) return null;
    const first = rows[0];
    if (!first) return null;
    return {
      credentialId: first.credentialId,
      mediaIds: rows.flatMap((row) => (row.mediaId ? [row.mediaId] : [])),
    };
  });
}

export async function dispatchDueXMedia(
  runtime: XDispatchRuntime,
  now = new Date(),
): Promise<number> {
  const jobs = await claimDueJobs(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
    limit: 10,
    provider: 'x',
    requireMedia: true,
  });
  let dispatched = 0;
  for (const job of jobs) {
    const context = await loadXJobContext(runtime.database, job.workspaceId, job.id);
    if (!context || context.mediaIds.length === 0) continue;
    const attempt = await startDispatchAttempt(runtime.database, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      workerId: runtime.workerId,
      fingerprint: `x-media:${job.revisionId}`,
      now,
    });
    if (!attempt) continue;
    const stored = await withTenantTransaction(
      runtime.database,
      { workspaceId: job.workspaceId },
      (transaction) => getActiveCredential(transaction, job.workspaceId, context.credentialId),
    );
    if (!stored) throw new Error('X account credential is unavailable');
    const plaintext = await decryptCredential(stored, runtime.keys);
    try {
      await stageXJobMedia(runtime.database, runtime.source, runtime.createClient, {
        workspaceId: job.workspaceId,
        jobId: job.id,
        credential: plaintext.toString('utf8'),
        mediaIds: context.mediaIds,
        idempotencyKey: attempt.idempotencyKey,
      });
    } finally {
      plaintext.fill(0);
    }
    dispatched += 1;
  }
  return dispatched;
}

export function createXMediaClientFactory(
  options: Pick<XHttpClientOptions, 'consumerKey' | 'consumerSecret'>,
): XMediaClientFactory {
  return (credential) => new XHttpClient(options).bindCredential(credential);
}

export async function stageXJobMedia(
  database: NodePgDatabase,
  source: XMediaSource,
  createClient: XMediaClientFactory,
  input: XMediaDispatchInput,
): Promise<{ mediaIds: string[]; state: 'succeeded' | 'pending' }> {
  const client = createClient(input.credential);
  const staged = [];
  for (const mediaId of input.mediaIds) {
    staged.push(
      await stageXMedia(database, source, client, {
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        mediaId,
        idempotencyKey: `${input.idempotencyKey}:${mediaId}`,
      }),
    );
  }
  return {
    mediaIds: staged.map((media) => media.mediaId),
    state: staged.some((media) => media.state === 'pending') ? 'pending' : 'succeeded',
  };
}
