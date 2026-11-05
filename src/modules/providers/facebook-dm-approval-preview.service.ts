import { createHash } from 'node:crypto';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { getEngagementProposal } from './engagement-proposal.repository.js';
import { getPageDmDelayWindow, PendingDmConflictError } from './facebook-dm-pending.repository.js';
import { chooseApprovedPageDmDueAt } from './facebook-dm-schedule-time.js';
import { FacebookDmConversationChangedError } from './facebook-messenger-send.service.js';

export function inboundFingerprint(messageId: string): string {
  return createHash('sha256').update(messageId).digest('hex');
}

export async function previewApprovedPageDm(
  database: NodePgDatabase,
  readWindow: (input: {
    workspaceId: string;
    accountId: string;
    conversationId: string;
  }) => Promise<{ latestInboundMessageId: string; windowDeadline: Date }>,
  input: { workspaceId: string; proposalId: string; expectedRevision: number },
) {
  const proposal = await getEngagementProposal(database, input.workspaceId, input.proposalId);
  if (!proposal) throw new PendingDmConflictError('Proposal cannot be scheduled');
  if (
    proposal.revision !== input.expectedRevision ||
    !['pending', 'expired'].includes(proposal.status) ||
    proposal.provider !== 'facebook_page' ||
    proposal.kind !== 'dm' ||
    !proposal.plannedDueAt
  )
    throw new PendingDmConflictError('Proposal cannot be scheduled');
  const [window, delay] = await Promise.all([
    readWindow({
      workspaceId: input.workspaceId,
      accountId: proposal.accountId,
      conversationId: proposal.targetId,
    }),
    getPageDmDelayWindow(database, {
      workspaceId: input.workspaceId,
      accountId: proposal.accountId,
    }),
  ]);
  if (!delay) throw new PendingDmConflictError('Page timing is unavailable');
  const source = proposal.sourceContext as { sourceMessageId?: unknown };
  if (
    typeof source.sourceMessageId === 'string' &&
    source.sourceMessageId !== window.latestInboundMessageId
  )
    throw new FacebookDmConversationChangedError();
  const previewedAt = new Date();
  const dueAt = chooseApprovedPageDmDueAt({
    plannedDueAt: proposal.plannedDueAt,
    approvedAt: previewedAt,
    windowDeadline: window.windowDeadline,
    earliestDelaySeconds: delay.earliestDelaySeconds,
    latestDelaySeconds: delay.latestDelaySeconds,
    randomValue: Math.random(),
  });
  return {
    dueAt: dueAt.toISOString(),
    previewedAt: previewedAt.toISOString(),
    latestInboundFingerprint: inboundFingerprint(window.latestInboundMessageId),
  };
}
