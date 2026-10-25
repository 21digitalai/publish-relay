import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  claimEngagementProposal,
  EngagementProposalError,
  getEngagementProposal,
  settleEngagementProposal,
} from './engagement-proposal.repository.js';
import type { FanvueCommentService } from './fanvue-comment.service.js';
import type { FanvueMessageService } from './fanvue-message.service.js';

export interface EngagementSendCommands {
  comments: Pick<FanvueCommentService, 'send'>;
  messages: Pick<FanvueMessageService, 'sendText'>;
}

type SendResult =
  | { state: 'confirmed'; providerObjectUuid: string }
  | { state: 'failed'; failureStatus: number }
  | { state: 'unknown' };

const contentSchema = z.strictObject({
  text: z.string().trim().min(1),
  mediaIds: z.array(z.uuid()).optional(),
  priceCents: z.number().optional(),
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
    (row.kind === 'comment' && content.data.text.length > 600) ||
    content.data.text.length > 5000 ||
    content.data.mediaIds?.length ||
    content.data.priceCents !== undefined
  )
    throw new EngagementProposalError('This proposal has no available send command', 409);
  return { kind: kind.data, targetId: target.data, text: content.data.text };
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
    const sent = await commands.messages.sendText({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      fanUuid: input.targetId,
      clientActionId: input.clientActionId,
      text: input.text,
      actor: { type: 'user', id: input.userId },
    });
    return sent.state === 'confirmed'
      ? { state: 'confirmed', providerObjectUuid: sent.messageUuid }
      : sent;
  } catch {
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
  const result = await sendProposal(commands, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    accountId: claimed.accountId,
    clientActionId: claimed.clientActionId,
    ...sendable,
  });
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
