import { createHash } from 'node:crypto';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import { enforceWorkspaceAction, type ActionPolicy } from '../policy/action-policy.js';
import { readScheduledCommentTarget } from './facebook-comments-read.service.js';
import {
  cancelPageCommentIntent,
  getPageCommentIntentByAction,
  getPageCommentIntent,
  PendingCommentConflictError,
  schedulePageComment,
} from './facebook-comment-pending.repository.js';
import type { FacebookHttpClient } from './facebook-http-client.js';
import { PageReadUnavailableError } from './facebook-page-read-context.service.js';

export const commentScheduleSchema = z.strictObject({
  workspaceId: z.uuid(),
  accountId: z.uuid(),
  postId: z
    .string()
    .regex(/^[0-9]+(?:_[0-9]+)*$/)
    .max(256),
  commentId: z
    .string()
    .regex(/^[0-9]+(?:_[0-9]+)*$/)
    .max(256),
  clientActionId: z.uuid(),
  text: z.string().trim().min(1).max(2000),
  dueAt: z.iso.datetime({ offset: true }),
  actor: z.strictObject({ type: z.enum(['user', 'api-key', 'delegated']), id: z.uuid() }),
});

export interface CommentScheduleRuntime {
  database: NodePgDatabase;
  keys: MasterKeyProvider;
  client: FacebookHttpClient;
  policy: ActionPolicy;
}

export async function scheduleAccountPageCommentReply(
  runtime: CommentScheduleRuntime,
  input: z.input<typeof commentScheduleSchema>,
) {
  const command = commentScheduleSchema.parse(input);
  const dueAt = new Date(command.dueAt);
  await withTenantTransaction(runtime.database, command, (tx) =>
    enforceWorkspaceAction(tx, runtime.policy, {
      workspaceId: command.workspaceId,
      actor: command.actor,
      action: 'engagement.send',
      request: { provider: 'facebook_page', providerAccountIds: [command.accountId] },
      requestedProviderAccountIds: [command.accountId],
    }),
  );
  const requestFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        accountId: command.accountId,
        postId: command.postId,
        commentId: command.commentId,
        text: command.text,
        dueAt: dueAt.toISOString(),
      }),
    )
    .digest('hex');
  const existing = await getPageCommentIntentByAction(runtime.database, command);
  if (existing) {
    const actorType = command.actor.type === 'api-key' ? 'api_key' : command.actor.type;
    if (
      existing.accountId !== command.accountId ||
      existing.postId !== command.postId ||
      existing.commentId !== command.commentId ||
      existing.requestFingerprint !== requestFingerprint ||
      existing.actorType !== actorType ||
      existing.actorId !== command.actor.id
    )
      throw new PendingCommentConflictError();
    return { id: existing.id, status: existing.status, dueAt: existing.dueAt.toISOString() };
  }
  if (dueAt.getTime() <= Date.now()) throw new PageReadUnavailableError();
  const target = await readScheduledCommentTarget(runtime, command);
  if (target.hasPageReply || !target.threadFingerprint) throw new PageReadUnavailableError();
  const intent = await schedulePageComment(runtime.database, {
    ...command,
    dueAt,
    requestFingerprint,
    targetText: target.text,
    targetCreatedAt: target.createdAt,
    threadFingerprint: target.threadFingerprint,
  });
  return { id: intent.id, status: intent.status, dueAt: intent.dueAt.toISOString() };
}

export async function getAccountPageCommentIntent(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; id: string },
) {
  const intent = await getPageCommentIntent(database, input);
  return intent
    ? { id: intent.id, status: intent.status, dueAt: intent.dueAt.toISOString() }
    : null;
}

export async function cancelAccountPageCommentIntent(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; id: string },
) {
  return cancelPageCommentIntent(database, input);
}
