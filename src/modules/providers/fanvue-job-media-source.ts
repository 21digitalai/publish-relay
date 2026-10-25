import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  mediaObjects,
  providerAccounts,
  publicationJobs,
  revisionMedia,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MediaStorage } from '../content/media-storage.js';

interface FanvueJobMediaInput {
  workspaceId: string;
  jobId: string;
  mediaId: string;
  leaseOwner: string;
  start: number;
  now?: Date;
}

export function fanvueJobMediaWhere(input: FanvueJobMediaInput, now: Date) {
  return and(
    eq(publicationJobs.workspaceId, input.workspaceId),
    eq(publicationJobs.id, input.jobId),
    eq(publicationJobs.state, 'leased'),
    eq(publicationJobs.leaseOwner, input.leaseOwner),
    gt(publicationJobs.leaseExpiresAt, now),
    eq(providerAccounts.destinationProvider, 'fanvue'),
    eq(providerAccounts.availability, 'active'),
    isNull(providerAccounts.disconnectedAt),
    eq(mediaObjects.id, input.mediaId),
    eq(mediaObjects.state, 'ready'),
    isNull(mediaObjects.deletedAt),
    sql`NOT EXISTS (SELECT 1 FROM publication_attempts attempt WHERE attempt.workspace_id = ${input.workspaceId} AND attempt.job_id = ${input.jobId})`,
  );
}

export async function openFanvueJobMediaRange(
  database: NodePgDatabase,
  storage: MediaStorage,
  input: FanvueJobMediaInput,
) {
  if (!storage.openVerifiedRange) throw new Error('Verified range storage is required');
  const now = input.now ?? new Date();
  const source = await withTenantTransaction(database, input, async (transaction) => {
    const [row] = await transaction
      .select({
        storageKey: mediaObjects.storageKey,
        sha256: mediaObjects.sha256,
        byteSize: mediaObjects.byteSize,
        mimeType: mediaObjects.mimeType,
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
        revisionMedia,
        and(
          eq(revisionMedia.workspaceId, publicationJobs.workspaceId),
          eq(revisionMedia.revisionId, publicationJobs.revisionId),
        ),
      )
      .innerJoin(
        mediaObjects,
        and(
          eq(mediaObjects.workspaceId, revisionMedia.workspaceId),
          eq(mediaObjects.id, revisionMedia.mediaId),
        ),
      )
      .where(fanvueJobMediaWhere(input, now))
      .limit(1);
    return row ?? null;
  });
  if (
    !source ||
    !Number.isSafeInteger(input.start) ||
    input.start < 0 ||
    input.start >= source.byteSize
  )
    throw new Error('Fanvue job media is unavailable');
  const stream = await storage.openVerifiedRange({
    storageKey: source.storageKey,
    sha256: source.sha256,
    byteSize: source.byteSize,
    start: input.start,
    end: source.byteSize - 1,
  });
  if (!stream) throw new Error('Fanvue job media failed verification');
  return { stream, byteSize: source.byteSize, mimeType: source.mimeType };
}
