import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  allowAllActionPolicy,
  enforceWorkspaceAction,
  type ActionName,
  type ActionPolicy,
} from '../policy/action-policy.js';
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
  actor?: { type: 'user' | 'api-key'; id: string };
  requestId?: string;
  idempotencyKey?: string;
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
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<{ postId: string; revisionId: string; jobIds: string[] }> {
  return withTenantTransaction(database, input, (transaction) =>
    createPostInTransaction(transaction, input, policy),
  );
}

export async function createPostInTransaction(
  transaction: NodePgDatabase,
  input: PostIntentInput,
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<{ postId: string; revisionId: string; jobIds: string[] }> {
  validatePostIntent(input);
  await enforcePostPolicy(transaction, input, 'publication.create', policy);
  return createPostIntent(transaction, input);
}

export async function editPost(
  database: NodePgDatabase,
  input: PostIntentInput & { postId: string; now?: Date },
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<{ postId: string; revisionId: string; jobIds: string[]; supersededJobIds: string[] }> {
  return withTenantTransaction(database, input, (transaction) =>
    editPostInTransaction(transaction, input, policy),
  );
}

export async function editPostInTransaction(
  transaction: NodePgDatabase,
  input: PostIntentInput & { postId: string; now?: Date },
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<{ postId: string; revisionId: string; jobIds: string[]; supersededJobIds: string[] }> {
  validatePostIntent(input);
  await enforcePostPolicy(transaction, input, 'publication.revise', policy);
  return revisePostIntent(transaction, { ...input, now: input.now ?? new Date() });
}

export async function reschedulePostInTransaction(
  transaction: NodePgDatabase,
  input: {
    workspaceId: string;
    userId?: string;
    actor?: { type: 'user' | 'api-key'; id: string };
    requestId?: string;
    idempotencyKey?: string;
    postId: string;
    scheduledAt: Date;
    now?: Date;
  },
  policy: ActionPolicy = allowAllActionPolicy,
) {
  if (!Number.isFinite(input.scheduledAt.getTime()))
    throw new PostValidationError('Scheduled time is invalid');
  await enforcePostPolicy(
    transaction,
    { ...input, userId: input.userId ?? 'system', providerAccountIds: [] },
    'publication.reschedule',
    policy,
  );
  return reschedulePostIntent(transaction, { ...input, now: input.now ?? new Date() });
}

export async function reschedulePost(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    userId?: string;
    actor?: { type: 'user' | 'api-key'; id: string };
    requestId?: string;
    idempotencyKey?: string;
    postId: string;
    scheduledAt: Date;
    now?: Date;
  },
  policy: ActionPolicy = allowAllActionPolicy,
) {
  return withTenantTransaction(database, input, (transaction) =>
    reschedulePostInTransaction(transaction, input, policy),
  );
}

async function enforcePostPolicy(
  transaction: NodePgDatabase,
  input: Pick<
    PostIntentInput,
    'workspaceId' | 'userId' | 'providerAccountIds' | 'actor' | 'requestId' | 'idempotencyKey'
  > & {
    scheduledAt: Date;
  },
  action: ActionName,
  policy: ActionPolicy,
): Promise<void> {
  await enforceWorkspaceAction(transaction, policy, {
    workspaceId: input.workspaceId,
    actor: input.actor ?? { type: 'user', id: input.userId },
    action,
    requestedProviderAccountIds: input.providerAccountIds,
    request: {
      providerAccountIds: input.providerAccountIds,
      scheduledAt: input.scheduledAt,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    },
  });
}
