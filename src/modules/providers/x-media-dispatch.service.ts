import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  mediaObjects,
  postRevisions,
  publicationAttempts,
  providerAccounts,
  providerConnections,
  publicationJobs,
  revisionMedia,
  xThreadParts,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { getActiveCredential } from '../credentials/credential.repository.js';
import { decryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
import {
  claimDueJobs,
  claimExactDueJob,
  claimReconciliationJobs,
  deriveJobIdempotencyKey,
  finishDispatchAttempt,
  recoverExpiredDispatches,
  resolveReconciliation,
  startDispatchAttempt,
} from '../scheduler/job.repository.js';
import {
  publishXThread,
  toXPublishFailure,
  XProviderAdapter,
  type XClient,
  type XPublishedThreadPart,
} from './x-adapter.js';
import { XHttpClient, type XHttpClientOptions } from './x-http-client.js';
import {
  stageXMedia,
  type XMediaSource,
  type XMediaUploadClient,
} from './x-media-staging.service.js';
import type { PublishOutcome } from './contract.js';

export interface XMediaDispatchInput {
  workspaceId: string;
  jobId: string;
  credential: string;
  mediaIds: readonly string[];
  idempotencyKey: string;
}

export type XMediaClientFactory = (credential: string) => XMediaUploadClient & Partial<XClient>;

export interface XDispatchRuntime {
  database: NodePgDatabase;
  keys: MasterKeyProvider;
  source: XMediaSource;
  createClient: XMediaClientFactory;
  workerId: string;
  leaseMs: number;
}

interface StoredXContent {
  kind?: unknown;
  type?: unknown;
  text?: unknown;
  posts?: unknown;
  quotedPostId?: unknown;
}

interface StoredXThreadPart {
  text?: unknown;
  mediaIds?: unknown;
}

export function normalizeStoredXContent(content: StoredXContent): {
  kind: 'text' | 'quote' | 'thread';
  text: string;
  quotedPostId?: string;
  posts?: { text: string; mediaIds?: string[] }[];
} {
  const kind = typeof content.kind === 'string' ? content.kind : content.type;
  if (kind === 'thread') {
    if (!Array.isArray(content.posts)) throw new Error('Stored X thread content is invalid');
    const posts = content.posts
      .map((value) => {
        if (typeof value === 'string') return { text: value.trim() };
        const part = value as StoredXThreadPart;
        if (typeof part.text !== 'string' || !Array.isArray(part.mediaIds))
          throw new Error('Stored X thread content is invalid');
        if (part.mediaIds.some((id) => typeof id !== 'string'))
          throw new Error('Stored X thread media assignment is invalid');
        return { text: part.text.trim(), mediaIds: part.mediaIds as string[] };
      })
      .filter((part) => part.text || (part.mediaIds?.length ?? 0) > 0);
    if (posts.length === 0) throw new Error('Stored X thread content is empty');
    return { kind: 'thread', text: posts[0]?.text ?? '', posts };
  }
  const text = typeof content.text === 'string' ? content.text : '';
  if (kind === 'quote') {
    if (typeof content.quotedPostId !== 'string' || !content.quotedPostId)
      throw new Error('Stored X quote content is missing its quoted post');
    return { kind: 'quote', text, quotedPostId: content.quotedPostId };
  }
  if (kind !== 'text') throw new Error(`Stored X content kind is unsupported: ${String(kind)}`);
  return { kind: 'text', text };
}

async function loadPublishedXThreadParts(
  database: NodePgDatabase,
  workspaceId: string,
  jobId: string,
): Promise<XPublishedThreadPart[]> {
  return withTenantTransaction(database, { workspaceId }, (transaction) =>
    transaction
      .select({
        position: xThreadParts.position,
        externalPostId: xThreadParts.externalPostId,
        externalUrl: xThreadParts.externalUrl,
      })
      .from(xThreadParts)
      .where(and(eq(xThreadParts.workspaceId, workspaceId), eq(xThreadParts.jobId, jobId)))
      .orderBy(asc(xThreadParts.position))
      .then((rows) =>
        rows.flatMap((row) =>
          row.externalPostId && row.externalUrl
            ? [{ ...row, externalPostId: row.externalPostId, externalUrl: row.externalUrl }]
            : [],
        ),
      ),
  );
}

async function beginXThreadPart(
  database: NodePgDatabase,
  workspaceId: string,
  jobId: string,
  position: number,
  dispatchKey: string,
  now: Date,
): Promise<void> {
  await withTenantTransaction(database, { workspaceId }, async (transaction) => {
    const inserted = await transaction
      .insert(xThreadParts)
      .values({
        workspaceId,
        jobId,
        position,
        dispatchKey,
        state: 'dispatching',
        dispatchStartedAt: now,
      })
      .onConflictDoNothing()
      .returning({ position: xThreadParts.position });
    if (inserted.length === 0)
      throw Object.assign(
        new Error(`X thread part ${String(position + 1)} has an ambiguous prior dispatch`),
        { outcomeUnknown: true, reconciliationKey: `x:manual:${dispatchKey}` },
      );
  });
}

async function savePublishedXThreadPart(
  database: NodePgDatabase,
  workspaceId: string,
  jobId: string,
  part: XPublishedThreadPart,
  now: Date,
): Promise<void> {
  await withTenantTransaction(database, { workspaceId }, async (transaction) => {
    await transaction
      .update(xThreadParts)
      .set({
        state: 'published',
        externalPostId: part.externalPostId,
        externalUrl: part.externalUrl,
        publishedAt: now,
      })
      .where(
        and(
          eq(xThreadParts.workspaceId, workspaceId),
          eq(xThreadParts.jobId, jobId),
          eq(xThreadParts.position, part.position),
        ),
      );
  });
}

function resolveThreadMediaIds(
  assignedIds: readonly string[],
  media: readonly { id: string }[],
  stagedIds: readonly string[],
): string[] {
  return assignedIds.map((id) => {
    const position = media.findIndex((item) => item.id === id);
    const stagedId = stagedIds[position];
    if (position < 0 || !stagedId)
      throw new Error(`X thread references unavailable revision media ${id}`);
    return stagedId;
  });
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
        accountId: providerAccounts.providerAccountId,
        content: postRevisions.content,
        mediaId: revisionMedia.mediaId,
        mimeType: mediaObjects.mimeType,
      })
      .from(publicationJobs)
      .innerJoin(
        postRevisions,
        and(
          eq(postRevisions.workspaceId, publicationJobs.workspaceId),
          eq(postRevisions.id, publicationJobs.revisionId),
        ),
      )
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
      .leftJoin(
        mediaObjects,
        and(
          eq(mediaObjects.workspaceId, revisionMedia.workspaceId),
          eq(mediaObjects.id, revisionMedia.mediaId),
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
      accountId: first.accountId,
      content: first.content as StoredXContent,
      media: rows.flatMap((row) =>
        row.mediaId && row.mimeType ? [{ id: row.mediaId, mimeType: row.mimeType }] : [],
      ),
    };
  });
}

export async function dispatchDueXJobs(
  runtime: XDispatchRuntime,
  now = new Date(),
  exactJob?: { workspaceId: string; jobId: string },
): Promise<number> {
  const claimedExact = exactJob
    ? await claimExactDueJob(runtime.database, {
        jobId: exactJob.jobId,
        workspaceId: exactJob.workspaceId,
        workerId: runtime.workerId,
        now,
        leaseMs: runtime.leaseMs,
      })
    : null;
  const jobs = exactJob
    ? claimedExact
      ? [claimedExact]
      : []
    : await claimDueJobs(runtime.database, {
        workerId: runtime.workerId,
        now,
        leaseMs: runtime.leaseMs,
        limit: 10,
        provider: 'x',
        requireMedia: false,
      });
  let dispatched = 0;
  for (const job of jobs) {
    const context = await loadXJobContext(runtime.database, job.workspaceId, job.id);
    if (!context) continue;
    const stored = await withTenantTransaction(
      runtime.database,
      { workspaceId: job.workspaceId },
      (transaction) => getActiveCredential(transaction, job.workspaceId, context.credentialId),
    );
    if (!stored) throw new Error('X account credential is unavailable');
    const plaintext = await decryptCredential(stored, runtime.keys);
    try {
      const idempotencyKey = deriveJobIdempotencyKey({
        jobId: job.id,
        revisionId: job.revisionId,
        providerAccountId: job.providerAccountId,
      });
      const stagedMedia = await stageXJobMedia(
        runtime.database,
        runtime.source,
        runtime.createClient,
        {
          workspaceId: job.workspaceId,
          jobId: job.id,
          credential: plaintext.toString('utf8'),
          mediaIds: context.media.map((media) => media.id),
          idempotencyKey,
        },
      );
      if (stagedMedia.state === 'pending') continue;
      const normalized = normalizeStoredXContent(context.content);
      const attempt = await startDispatchAttempt(runtime.database, {
        workspaceId: job.workspaceId,
        jobId: job.id,
        workerId: runtime.workerId,
        fingerprint: idempotencyKey,
        now,
      });
      if (!attempt) continue;
      const client = runtime.createClient(plaintext.toString('utf8')) as XMediaUploadClient &
        XClient;
      const adapter = new XProviderAdapter(client);
      let outcome: PublishOutcome;
      if (normalized.kind === 'thread' && normalized.posts) {
        const completed = await loadPublishedXThreadParts(
          runtime.database,
          job.workspaceId,
          job.id,
        );
        try {
          const published = await publishXThread(
            client,
            normalized.posts.map((part, position) => ({
              text: part.text,
              mediaIds:
                part.mediaIds !== undefined
                  ? resolveThreadMediaIds(part.mediaIds, context.media, stagedMedia.mediaIds)
                  : position === 0
                    ? stagedMedia.mediaIds
                    : [],
            })),
            idempotencyKey,
            completed,
            (part) =>
              savePublishedXThreadPart(runtime.database, job.workspaceId, job.id, part, new Date()),
            (position, dispatchKey) =>
              beginXThreadPart(
                runtime.database,
                job.workspaceId,
                job.id,
                position,
                dispatchKey,
                new Date(),
              ),
          );
          const root = published[0];
          if (!root) throw new Error('X thread did not publish a root post');
          outcome = {
            status: 'published',
            externalPostId: root.externalPostId,
            externalUrl: root.externalUrl,
          };
        } catch (error) {
          const failure = toXPublishFailure(error);
          outcome =
            failure.status === 'unknown' && 'reconciliationKey' in (error as object)
              ? {
                  status: 'unknown',
                  reconciliationKey: (error as { reconciliationKey: string }).reconciliationKey,
                }
              : failure;
        }
      } else {
        const content =
          normalized.kind === 'quote' && normalized.quotedPostId
            ? {
                kind: 'quote' as const,
                text: normalized.text,
                quotedPostId: normalized.quotedPostId,
                media: context.media,
              }
            : { kind: 'text' as const, text: normalized.text, media: context.media };
        const staged = await adapter.stage(
          context.accountId,
          {
            ...content,
            media: content.media.map((media, index) => ({
              ...media,
              id: stagedMedia.mediaIds[index] ?? media.id,
            })),
          },
          idempotencyKey,
        );
        outcome = await adapter.publish(staged);
      }
      const retryAt =
        outcome.status === 'failed' &&
        (outcome.code === 'rate_limit' || outcome.code === 'transient')
          ? new Date(now.getTime() + (outcome.retryAfterSeconds ?? 30) * 1000)
          : undefined;
      await finishDispatchAttempt(runtime.database, {
        workspaceId: job.workspaceId,
        jobId: job.id,
        attemptId: attempt.attemptId,
        outcome: outcome.status === 'failed' ? outcome.code : outcome.status,
        now,
        ...(retryAt ? { retryAt } : {}),
        ...(outcome.status === 'published' ? { externalPostId: outcome.externalPostId } : {}),
        ...(outcome.status === 'accepted_pending'
          ? { reconciliationKey: outcome.providerJobId }
          : {}),
        ...(outcome.status === 'unknown' ? { reconciliationKey: outcome.reconciliationKey } : {}),
        ...(outcome.status === 'failed' ? { redactedError: outcome.message } : {}),
      });
    } finally {
      plaintext.fill(0);
    }
    dispatched += 1;
  }
  return dispatched;
}

async function loadXReconciliationContext(
  database: NodePgDatabase,
  jobId: string,
): Promise<{ workspaceId: string; credentialId: string; reconciliationKey: string } | null> {
  const rows = await database
    .select({
      workspaceId: publicationJobs.workspaceId,
      credentialId: providerConnections.credentialId,
      reconciliationKey: publicationAttempts.reconciliationKey,
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
    .innerJoin(
      publicationAttempts,
      and(
        eq(publicationAttempts.workspaceId, publicationJobs.workspaceId),
        eq(publicationAttempts.jobId, publicationJobs.id),
      ),
    )
    .where(and(eq(publicationJobs.id, jobId), eq(providerConnections.provider, 'x')))
    .orderBy(asc(publicationAttempts.startedAt));
  const row = rows.at(-1);
  return row?.reconciliationKey ? { ...row, reconciliationKey: row.reconciliationKey } : null;
}

export async function reconcileXJobs(runtime: XDispatchRuntime, now = new Date()): Promise<number> {
  await recoverExpiredDispatches(runtime.database, now);
  const jobIds = await claimReconciliationJobs(runtime.database, {
    workerId: runtime.workerId,
    now,
    leaseMs: runtime.leaseMs,
    limit: 10,
    provider: 'x',
  });
  let resolved = 0;
  for (const jobId of jobIds) {
    const context = await loadXReconciliationContext(runtime.database, jobId);
    if (!context) continue;
    const stored = await withTenantTransaction(
      runtime.database,
      { workspaceId: context.workspaceId },
      (transaction) => getActiveCredential(transaction, context.workspaceId, context.credentialId),
    );
    if (!stored) throw new Error('X account credential is unavailable');
    const plaintext = await decryptCredential(stored, runtime.keys);
    try {
      const adapter = new XProviderAdapter(
        runtime.createClient(plaintext.toString('utf8')) as XMediaUploadClient & XClient,
      );
      const outcome = await adapter.lookup(context.reconciliationKey);
      if (outcome.status === 'unknown') continue;
      const retryAt =
        outcome.status === 'failed' &&
        (outcome.code === 'rate_limit' || outcome.code === 'transient')
          ? new Date(now.getTime() + (outcome.retryAfterSeconds ?? 30) * 1000)
          : undefined;
      const state =
        outcome.status === 'published'
          ? 'published'
          : outcome.status === 'accepted_pending'
            ? 'accepted_pending'
            : retryAt
              ? 'retry_wait'
              : 'failed';
      if (
        await resolveReconciliation(runtime.database, {
          workspaceId: context.workspaceId,
          jobId,
          workerId: runtime.workerId,
          outcome: state,
          now,
          ...(retryAt ? { retryAt } : {}),
        })
      )
        resolved += 1;
    } finally {
      plaintext.fill(0);
    }
  }
  return resolved;
}

export const dispatchDueXMedia = dispatchDueXJobs;

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
