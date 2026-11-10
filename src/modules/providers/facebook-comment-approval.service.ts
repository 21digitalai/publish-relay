import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { engagementProposals } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { enforceWorkspaceAction } from '../policy/action-policy.js';
import type { CommentScheduleRuntime } from './facebook-comment-schedule.service.js';
import { readScheduledCommentTarget } from './facebook-comments-read.service.js';
import {
  PendingCommentConflictError,
  schedulePageCommentInTransaction,
} from './facebook-comment-pending.repository.js';
import { PageReadUnavailableError } from './facebook-page-read-context.service.js';

const sourceSchema = z.object({
  postId: z
    .string()
    .regex(/^[0-9]+(?:_[0-9]+)*$/)
    .max(256),
});
const contentSchema = z.object({ text: z.string().trim().min(1).max(2000) });
const commentIdSchema = z
  .string()
  .regex(/^[0-9]+(?:_[0-9]+)*$/)
  .max(256);

/** The proposal and its Page intent commit together; no provider call occurs here. */
export async function scheduleApprovedPageComment(
  runtime: CommentScheduleRuntime,
  input: { workspaceId: string; userId: string; proposalId: string; expectedRevision: number },
) {
  const preliminary = await withTenantTransaction(runtime.database, input, async (tx) => {
    const [row] = await tx
      .select()
      .from(engagementProposals)
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.proposalId),
        ),
      )
      .limit(1);
    return row;
  });
  if (
    preliminary?.provider !== 'facebook_page' ||
    preliminary.kind !== 'comment' ||
    preliminary.status !== 'pending' ||
    preliminary.revision !== input.expectedRevision
  )
    throw new PendingCommentConflictError('Proposal is stale or unavailable');
  const source = sourceSchema.safeParse(preliminary.sourceContext);
  const content = contentSchema.safeParse(preliminary.content);
  const commentId = commentIdSchema.safeParse(preliminary.targetId);
  if (!source.success || !content.success || !commentId.success)
    throw new PendingCommentConflictError('Proposal has no schedulable Page comment');
  const target = await readScheduledCommentTarget(runtime, {
    workspaceId: input.workspaceId,
    accountId: preliminary.accountId,
    postId: source.data.postId,
    commentId: commentId.data,
  });
  if (target.hasPageReply || !target.threadFingerprint) throw new PageReadUnavailableError();
  const threadFingerprint = target.threadFingerprint;
  const now = Date.now();
  const dueAt = new Date(Math.max(preliminary.plannedDueAt?.getTime() ?? now, now + 1_000));
  const requestFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        accountId: preliminary.accountId,
        postId: source.data.postId,
        commentId: commentId.data,
        text: content.data.text,
        dueAt: dueAt.toISOString(),
      }),
    )
    .digest('hex');
  return withTenantTransaction(runtime.database, input, async (tx) => {
    const [proposal] = await tx
      .select()
      .from(engagementProposals)
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.proposalId),
        ),
      )
      .limit(1)
      .for('update');
    if (
      proposal?.status !== 'pending' ||
      proposal.revision !== input.expectedRevision ||
      proposal.accountId !== preliminary.accountId ||
      proposal.targetId !== preliminary.targetId ||
      JSON.stringify(proposal.content) !== JSON.stringify(preliminary.content) ||
      JSON.stringify(proposal.sourceContext) !== JSON.stringify(preliminary.sourceContext)
    )
      throw new PendingCommentConflictError('Proposal changed before approval');
    await enforceWorkspaceAction(tx, runtime.policy, {
      workspaceId: input.workspaceId,
      actor: { type: 'user', id: input.userId },
      action: 'engagement.send',
      request: { provider: 'facebook_page', providerAccountIds: [proposal.accountId] },
      requestedProviderAccountIds: [proposal.accountId],
    });
    const intent = await schedulePageCommentInTransaction(tx, {
      workspaceId: input.workspaceId,
      accountId: proposal.accountId,
      postId: source.data.postId,
      commentId: commentId.data,
      clientActionId: proposal.clientActionId,
      requestFingerprint,
      actor: { type: 'user', id: input.userId },
      text: content.data.text,
      targetText: target.text,
      targetCreatedAt: target.createdAt,
      threadFingerprint,
      dueAt,
    });
    await tx
      .update(engagementProposals)
      .set({ status: 'scheduled', updatedAt: new Date() })
      .where(eq(engagementProposals.id, proposal.id));
    return { id: proposal.id, status: 'scheduled', dueAt: intent.dueAt.toISOString() };
  });
}
