import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { PostValidationError } from './post.errors.js';
import {
  createPostIntent,
  reschedulePostIntent,
  revisePostIntent,
  type PostRevisionInput,
} from './post.repository.js';

export interface PostIntentInput extends PostRevisionInput {
  workspaceId: string;
  userId: string;
}

function validatePostIntent(input: PostIntentInput): void {
  if (input.providerAccountIds.length === 0)
    throw new PostValidationError('At least one provider account is required');
  if (new Set(input.providerAccountIds).size !== input.providerAccountIds.length)
    throw new PostValidationError('Provider account targets must be unique');
  if (new Set(input.mediaIds).size !== input.mediaIds.length)
    throw new PostValidationError('Media references must be unique');
  if (!Number.isFinite(input.scheduledAt.getTime()))
    throw new PostValidationError('Scheduled time is invalid');
}

export async function createPost(
  database: NodePgDatabase,
  input: PostIntentInput,
): Promise<{ postId: string; revisionId: string; jobIds: string[] }> {
  return withTenantTransaction(database, input, (transaction) =>
    createPostInTransaction(transaction, input),
  );
}

export async function createPostInTransaction(
  transaction: NodePgDatabase,
  input: PostIntentInput,
): Promise<{ postId: string; revisionId: string; jobIds: string[] }> {
  validatePostIntent(input);
  return createPostIntent(transaction, input);
}

export async function editPost(
  database: NodePgDatabase,
  input: PostIntentInput & { postId: string; now?: Date },
): Promise<{ postId: string; revisionId: string; jobIds: string[]; supersededJobIds: string[] }> {
  return withTenantTransaction(database, input, (transaction) =>
    editPostInTransaction(transaction, input),
  );
}

export async function editPostInTransaction(
  transaction: NodePgDatabase,
  input: PostIntentInput & { postId: string; now?: Date },
): Promise<{ postId: string; revisionId: string; jobIds: string[]; supersededJobIds: string[] }> {
  validatePostIntent(input);
  return revisePostIntent(transaction, { ...input, now: input.now ?? new Date() });
}

export async function reschedulePostInTransaction(
  transaction: NodePgDatabase,
  input: { workspaceId: string; postId: string; scheduledAt: Date; now?: Date },
) {
  if (!Number.isFinite(input.scheduledAt.getTime()))
    throw new PostValidationError('Scheduled time is invalid');
  return reschedulePostIntent(transaction, { ...input, now: input.now ?? new Date() });
}

export async function reschedulePost(
  database: NodePgDatabase,
  input: { workspaceId: string; postId: string; scheduledAt: Date; now?: Date },
) {
  return withTenantTransaction(database, input, (transaction) =>
    reschedulePostInTransaction(transaction, input),
  );
}
