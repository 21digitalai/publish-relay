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

export interface EngagementSendCommands {
  comments: Pick<FanvueCommentService, 'send'>;
  messages: Pick<FanvueMessageService, 'sendText' | 'sendMessage'>;
}

type SendResult =
  | { state: 'confirmed'; providerObjectUuid: string }
  | { state: 'failed'; failureStatus: number }
  | { state: 'unknown' };

const contentSchema = z.strictObject({
  text: z.string().trim().min(1),
  mediaIds: z.array(z.uuid()).min(1).max(10).optional(),
  priceCents: z.number().int().nonnegative().optional(),
});

function sendableProposal(row: NonNullable<Awaited<ReturnType<typeof getEngagementProposal>>>) {
  const content = contentSchema.safeParse(row.content);
  const target = z.uuid().safeParse(row.targetId);
  const kind = z.enum(['comment', 'dm']).safeParse(row.kind);
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
  },
): Promise<SendResult> {
  try {
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
    if (isFanvuePreSendError(error)) throw error;
    // A thrown command can have reached the provider; never turn it into a retryable state.
    return { state: 'unknown' };
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
    if (!isFanvuePreSendError(error)) throw error;
    await releaseEngagementProposalClaim(database, {
      workspaceId: input.workspaceId,
      id: claimed.id,
      clientActionId: claimed.clientActionId,
      expectedRevision: claimed.revision,
    });
    throw new EngagementProposalError('Fanvue send permission or destination is unavailable', 409);
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
