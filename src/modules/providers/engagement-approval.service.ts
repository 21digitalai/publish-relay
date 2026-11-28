import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  claimEngagementProposal,
  EngagementProposalError,
  getEngagementProposal,
  releaseEngagementProposalClaim,
  settleEngagementProposal,
} from './engagement-proposal.repository.js';
import type { FanvueCommentService } from './fanvue-comment.service.js';
import type { FanvueMessageService } from './fanvue-message.service.js';
import { isFanvuePreSendError } from './fanvue-pre-send-error.js';
import {
  FanvueDmScheduleConflictError,
  scheduleApprovedFanvueDm,
} from './fanvue-dm-pending.repository.js';
import {
  FanvueCommentScheduleConflictError,
  scheduleApprovedFanvueComment,
} from './fanvue-comment-pending.repository.js';
import {
  FacebookDmNoGoError,
  FacebookDmWindowClosedError,
} from './facebook-messenger-send.service.js';
import { PageReadUnavailableError } from './facebook-page-read-context.service.js';
import { FacebookRequestError } from './facebook-http-client.js';
import {
  FacebookCommentActionConflictError,
  type sendAccountPageCommentReply,
} from './facebook-comment-send.service.js';
import {
  FacebookDmActionConflictError,
  type sendAccountPageConversationMessage,
} from './facebook-messenger-send.service.js';
import { ActionPolicyDeniedError } from '../policy/action-policy.js';
import type { scheduleApprovedPageComment } from './facebook-comment-approval.service.js';
import type { createInstagramUnifiedScheduleService } from './instagram-unified-schedule.service.js';

export interface EngagementSendCommands {
  comments?: Pick<FanvueCommentService, 'send'> &
    Partial<Pick<FanvueCommentService, 'preflightScheduledComment'>>;
  messages?: Pick<FanvueMessageService, 'sendText' | 'sendMessage' | 'preflightScheduledMessage'>;
  facebook?: {
    scheduleComment?: (
      input: Parameters<typeof scheduleApprovedPageComment>[1],
    ) => ReturnType<typeof scheduleApprovedPageComment>;
    sendComment: (
      input: Parameters<typeof sendAccountPageCommentReply>[1],
    ) => ReturnType<typeof sendAccountPageCommentReply>;
    sendDm: (
      input: Parameters<typeof sendAccountPageConversationMessage>[1],
    ) => ReturnType<typeof sendAccountPageConversationMessage>;
    previewDmWindow: (input: {
      workspaceId: string;
      accountId: string;
      conversationId: string;
    }) => Promise<{ latestInboundMessageId: string; latestInboundAt: Date; windowDeadline: Date }>;
  };
  unified?: Pick<ReturnType<typeof createInstagramUnifiedScheduleService>, 'schedule'>;
}

type SendResult =
  | { state: 'confirmed'; providerObjectUuid: string }
  | { state: 'failed'; failureStatus: number }
  | { state: 'unknown' };

function isProvenPreSendError(error: unknown): boolean {
  return (
    isFanvuePreSendError(error) ||
    error instanceof EngagementProposalError ||
    error instanceof PageReadUnavailableError ||
    error instanceof FacebookDmWindowClosedError ||
    error instanceof FacebookDmNoGoError ||
    error instanceof FacebookRequestError ||
    error instanceof FacebookCommentActionConflictError ||
    error instanceof FacebookDmActionConflictError ||
    error instanceof ActionPolicyDeniedError ||
    error instanceof z.ZodError
  );
}

const contentSchema = z.strictObject({
  text: z.string().trim().min(1),
  mediaIds: z.array(z.uuid()).min(1).max(10).optional(),
  priceCents: z.number().int().nonnegative().optional(),
});

function sendableProposal(row: NonNullable<Awaited<ReturnType<typeof getEngagementProposal>>>) {
  const content = contentSchema.safeParse(row.content);
  const kind = z.enum(['comment', 'dm']).safeParse(row.kind);
  if (row.provider === 'facebook_page') {
    const source = z
      .strictObject({
        text: z.string().optional(),
        authorLabel: z.string().optional(),
        postId: z
          .string()
          .regex(/^[0-9]+(?:_[0-9]+)*$/)
          .max(256)
          .optional(),
        sourceMessageId: z.string().max(256).optional(),
      })
      .safeParse(row.sourceContext);
    const target = (
      row.kind === 'comment'
        ? z.string().regex(/^[0-9]+(?:_[0-9]+)*$/)
        : z.string().regex(/^[A-Za-z0-9_]+$/)
    )
      .max(200)
      .safeParse(row.targetId);
    if (
      !kind.success ||
      !content.success ||
      !source.success ||
      !target.success ||
      content.data.text.length > 2000 ||
      content.data.mediaIds?.length ||
      content.data.priceCents !== undefined ||
      (row.kind === 'comment' && !source.data.postId)
    )
      throw new EngagementProposalError('This proposal has no available send command', 409);
    return {
      provider: 'facebook_page' as const,
      kind: kind.data,
      targetId: target.data,
      text: content.data.text,
      ...(source.data.postId ? { postId: source.data.postId } : {}),
    };
  }
  if (row.provider === 'instagram_unified_login') {
    const source = z
      .strictObject({
        parentId: z.string().min(1).max(256),
        recipientId: z.string().min(1).max(256).optional(),
      })
      .safeParse(row.sourceContext);
    if (
      !kind.success ||
      !content.success ||
      !source.success ||
      content.data.mediaIds?.length ||
      content.data.priceCents !== undefined ||
      content.data.text.length > 2000
    )
      throw new EngagementProposalError('This proposal has no available send command', 409);
    if (row.kind === 'dm' && !source.data.recipientId)
      throw new EngagementProposalError('Unified Instagram recipient is required', 409);
    if (!row.plannedDueAt || row.plannedDueAt.getTime() <= Date.now())
      throw new EngagementProposalError(
        'Unified Instagram approval requires a future due time',
        409,
      );
    return {
      provider: 'instagram_unified_login' as const,
      kind: kind.data,
      targetId: row.targetId,
      text: content.data.text,
      parentId: source.data.parentId,
      ...(source.data.recipientId ? { recipientId: source.data.recipientId } : {}),
      dueAt: row.plannedDueAt,
    };
  }
  const target = z.uuid().safeParse(row.targetId);
  if (
    row.provider !== 'fanvue' ||
    !kind.success ||
    !content.success ||
    !target.success ||
    (row.kind === 'comment' &&
      (content.data.text.length > 600 ||
        content.data.mediaIds?.length ||
        content.data.priceCents !== undefined)) ||
    content.data.text.length > 5000 ||
    (content.data.priceCents !== undefined && !content.data.mediaIds?.length) ||
    (content.data.priceCents !== undefined &&
      content.data.priceCents > 0 &&
      content.data.priceCents < 300)
  )
    throw new EngagementProposalError('This proposal has no available send command', 409);
  return {
    provider: 'fanvue' as const,
    kind: kind.data,
    targetId: target.data,
    text: content.data.text,
    ...(content.data.mediaIds ? { mediaIds: content.data.mediaIds } : {}),
    ...(content.data.priceCents ? { price: content.data.priceCents } : {}),
  };
}

async function sendProposal(
  commands: EngagementSendCommands,
  input: {
    workspaceId: string;
    userId: string;
    accountId: string;
    clientActionId: string;
    kind: 'comment' | 'dm';
    targetId: string;
    text: string;
    mediaIds?: string[];
    price?: number;
    provider: 'fanvue' | 'facebook_page' | 'instagram_unified_login';
    postId?: string;
  },
): Promise<SendResult> {
  try {
    if (input.provider === 'facebook_page') {
      if (!commands.facebook)
        throw new EngagementProposalError('Facebook send is unavailable', 409);
      if (input.kind === 'comment') {
        if (!input.postId) throw new EngagementProposalError('Page post is required', 409);
        const sent = await commands.facebook.sendComment({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          postId: input.postId,
          commentId: input.targetId,
          clientActionId: input.clientActionId,
          text: input.text,
          actor: { type: 'user', id: input.userId },
        });
        return sent.state === 'confirmed'
          ? { state: 'confirmed', providerObjectUuid: sent.commentId }
          : sent;
      }
      const sent = await commands.facebook.sendDm({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.targetId,
        clientActionId: input.clientActionId,
        text: input.text,
        actor: { type: 'user', id: input.userId },
      });
      return sent.state === 'confirmed'
        ? { state: 'confirmed', providerObjectUuid: sent.messageId }
        : sent;
    }
    if (!commands.comments || !commands.messages)
      throw new EngagementProposalError('Fanvue send is unavailable', 409);
    if (input.kind === 'comment') {
      const sent = await commands.comments.send({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        postUuid: input.targetId,
        clientActionId: input.clientActionId,
        text: input.text,
        actor: { type: 'user', id: input.userId },
      });
      return sent.state === 'confirmed'
        ? { state: 'confirmed', providerObjectUuid: sent.commentUuid }
        : sent;
    }
    const message = {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      fanUuid: input.targetId,
      clientActionId: input.clientActionId,
      text: input.text,
      actor: { type: 'user', id: input.userId },
    } as const;
    const sent = input.mediaIds
      ? await commands.messages.sendMessage({
          ...message,
          mediaIds: input.mediaIds,
          ...(input.price ? { price: input.price } : {}),
        })
      : await commands.messages.sendText(message);
    return sent.state === 'confirmed'
      ? { state: 'confirmed', providerObjectUuid: sent.messageUuid }
      : sent;
  } catch (error) {
    if (isProvenPreSendError(error)) throw error;
    // A thrown command can have reached the provider; never turn it into a retryable state.
    return { state: 'unknown' };
  }
}

export async function scheduleInstagramUnifiedProposal(
  database: NodePgDatabase,
  commands: EngagementSendCommands,
  input: { workspaceId: string; userId: string; proposalId: string; expectedRevision: number },
) {
  const proposal = await getEngagementProposal(database, input.workspaceId, input.proposalId);
  if (proposal?.status !== 'pending' || proposal.revision !== input.expectedRevision)
    throw new EngagementProposalError('Proposal is stale or unavailable', 409);
  const sendable = sendableProposal(proposal);
  if (sendable.provider !== 'instagram_unified_login' || !commands.unified)
    throw new EngagementProposalError('Unified Instagram scheduling is unavailable', 409);
  try {
    return await commands.unified.schedule({
      workspaceId: input.workspaceId,
      accountId: proposal.accountId,
      clientActionId: proposal.clientActionId,
      kind: sendable.kind === 'comment' ? 'comment_reply' : 'dm_reply',
      targetId: sendable.targetId,
      parentId: sendable.parentId,
      ...(sendable.recipientId ? { recipientId: sendable.recipientId } : {}),
      text: sendable.text,
      dueAt: sendable.dueAt.toISOString(),
      actor: { type: 'user', id: input.userId },
    });
  } catch (error) {
    if (error instanceof EngagementProposalError) throw error;
    throw new EngagementProposalError('Unified Instagram reply is no longer eligible', 409);
  }
}

export async function approveEngagementProposal(
  database: NodePgDatabase,
  commands: EngagementSendCommands,
  input: { workspaceId: string; userId: string; proposalId: string; expectedRevision: number },
) {
  const pending = await getEngagementProposal(database, input.workspaceId, input.proposalId);
  if (pending?.status !== 'pending' || pending.revision !== input.expectedRevision)
    throw new EngagementProposalError('Proposal is stale or unavailable', 409);
  const sendable = sendableProposal(pending);
  const claimed = await claimEngagementProposal(database, {
    workspaceId: input.workspaceId,
    id: input.proposalId,
    expectedRevision: input.expectedRevision,
  });
  let result: SendResult;
  try {
    result = await sendProposal(commands, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      accountId: claimed.accountId,
      clientActionId: claimed.clientActionId,
      ...sendable,
    });
  } catch (error) {
    if (!isProvenPreSendError(error)) throw error;
    await releaseEngagementProposalClaim(database, {
      workspaceId: input.workspaceId,
      id: claimed.id,
      clientActionId: claimed.clientActionId,
      expectedRevision: claimed.revision,
    });
    throw new EngagementProposalError('Send permission or destination is unavailable', 409);
  }
  const status = result.state === 'confirmed' ? 'sent' : result.state;
  const settled = await settleEngagementProposal(database, {
    workspaceId: input.workspaceId,
    id: claimed.id,
    clientActionId: claimed.clientActionId,
    expectedRevision: claimed.revision,
    status,
  });
  return {
    id: settled.id,
    status: settled.status,
    ...(result.state === 'confirmed' ? { providerObjectId: result.providerObjectUuid } : {}),
  };
}

export async function scheduleFanvueProposal(
  database: NodePgDatabase,
  commands: EngagementSendCommands,
  input: { workspaceId: string; userId: string; proposalId: string; expectedRevision: number },
) {
  const proposal = await getEngagementProposal(database, input.workspaceId, input.proposalId);
  if (proposal?.status !== 'pending' || proposal.revision !== input.expectedRevision)
    throw new EngagementProposalError('Proposal is stale or unavailable', 409);
  const sendable = sendableProposal(proposal);
  if (sendable.provider !== 'fanvue')
    throw new EngagementProposalError('Fanvue scheduling is unavailable', 409);
  if (sendable.kind === 'comment') {
    if (!commands.comments?.preflightScheduledComment)
      throw new EngagementProposalError('Fanvue comment scheduling is unavailable', 409);
    try {
      const targetLabel = await commands.comments.preflightScheduledComment({
        workspaceId: input.workspaceId,
        accountId: proposal.accountId,
        postUuid: sendable.targetId,
        clientActionId: proposal.clientActionId,
        text: sendable.text,
        actor: { type: 'user', id: input.userId },
      });
      return await scheduleApprovedFanvueComment(database, {
        ...input,
        accountId: proposal.accountId,
        postUuid: sendable.targetId,
        clientActionId: proposal.clientActionId,
        content: proposal.content,
        text: sendable.text,
        targetLabel,
      });
    } catch (error) {
      if (isFanvuePreSendError(error) || error instanceof FanvueCommentScheduleConflictError)
        throw new EngagementProposalError('Send permission or destination is unavailable', 409);
      throw error;
    }
  }
  if (!commands.messages)
    throw new EngagementProposalError('Fanvue DM scheduling is unavailable', 409);
  const command = {
    workspaceId: input.workspaceId,
    accountId: proposal.accountId,
    fanUuid: sendable.targetId,
    clientActionId: proposal.clientActionId,
    actor: { type: 'user' as const, id: input.userId },
    text: sendable.text,
    ...(sendable.mediaIds ? { mediaIds: sendable.mediaIds } : {}),
    ...(sendable.price !== undefined ? { price: sendable.price } : {}),
    dueAt: proposal.plannedDueAt ?? new Date(),
  };
  try {
    const targetLabel = await commands.messages.preflightScheduledMessage(command);
    return await scheduleApprovedFanvueDm(database, {
      ...input,
      accountId: proposal.accountId,
      fanUuid: sendable.targetId,
      clientActionId: proposal.clientActionId,
      content: proposal.content,
      text: sendable.text,
      ...(sendable.mediaIds ? { mediaIds: sendable.mediaIds } : {}),
      ...(sendable.price !== undefined ? { price: sendable.price } : {}),
      targetLabel,
    });
  } catch (error) {
    if (isFanvuePreSendError(error) || error instanceof FanvueDmScheduleConflictError)
      throw new EngagementProposalError('Send permission or destination is unavailable', 409);
    throw error;
  }
}
