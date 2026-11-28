import { describe, expect, it, vi } from 'vitest';
import type * as ProposalRepository from '../src/modules/providers/engagement-proposal.repository.js';

const repository = vi.hoisted(() => ({
  getEngagementProposal: vi.fn(),
}));

vi.mock('../src/modules/providers/engagement-proposal.repository.js', async () => {
  const actual = await vi.importActual<typeof ProposalRepository>(
    '../src/modules/providers/engagement-proposal.repository.js',
  );
  return {
    ...actual,
    getEngagementProposal: repository.getEngagementProposal,
  };
});

import { scheduleInstagramUnifiedProposal } from '../src/modules/providers/engagement-approval.service.js';

const workspaceId = '00000000-0000-4000-8000-000000000101';
const userId = '00000000-0000-4000-8000-000000000102';
const accountId = '00000000-0000-4000-8000-000000000103';
const proposalId = '00000000-0000-4000-8000-000000000104';
const clientActionId = '00000000-0000-4000-8000-000000000105';

function proposal(kind: 'comment' | 'dm' = 'dm') {
  return {
    id: proposalId,
    workspaceId,
    accountId,
    clientActionId,
    provider: 'instagram_unified_login' as const,
    kind,
    targetId: kind === 'dm' ? 'message-1' : 'comment-1',
    sourceContext:
      kind === 'dm'
        ? { parentId: 'conversation-1', recipientId: 'recipient-1' }
        : { parentId: 'media-1' },
    content: { text: 'Exact reviewed reply' },
    plannedDueAt: new Date(Date.now() + 60_000),
    status: 'pending' as const,
    revision: 1,
  };
}

describe('Unified Instagram engagement proposal approval orchestration', () => {
  it.each(['comment', 'dm'] as const)(
    'passes the exact reviewed %s payload to the sole Unified scheduler without provider send',
    async (kind) => {
      const row = proposal(kind);
      repository.getEngagementProposal.mockResolvedValueOnce(row);
      const schedule = vi.fn().mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000106',
        status: 'pending',
        dueAt: row.plannedDueAt.toISOString(),
      });
      const result = await scheduleInstagramUnifiedProposal(
        {} as never,
        { unified: { schedule } },
        { workspaceId, userId, proposalId, expectedRevision: 1 },
      );

      expect(result.status).toBe('pending');
      expect(schedule).toHaveBeenCalledWith({
        workspaceId,
        accountId,
        clientActionId,
        kind: kind === 'dm' ? 'dm_reply' : 'comment_reply',
        targetId: row.targetId,
        parentId: row.sourceContext.parentId,
        ...(kind === 'dm' ? { recipientId: 'recipient-1' } : {}),
        text: 'Exact reviewed reply',
        dueAt: row.plannedDueAt.toISOString(),
        actor: { type: 'user', id: userId },
      });
      expect(schedule).toHaveBeenCalledTimes(1);
    },
  );

  it('fails closed for stale, expired, and failed eligibility without sending', async () => {
    repository.getEngagementProposal.mockResolvedValueOnce({
      ...proposal(),
      plannedDueAt: new Date(Date.now() - 1_000),
    });
    const schedule = vi.fn();
    await expect(
      scheduleInstagramUnifiedProposal(
        {} as never,
        { unified: { schedule } },
        { workspaceId, userId, proposalId, expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(schedule).not.toHaveBeenCalled();

    repository.getEngagementProposal.mockResolvedValueOnce({ ...proposal(), revision: 2 });
    await expect(
      scheduleInstagramUnifiedProposal(
        {} as never,
        { unified: { schedule } },
        { workspaceId, userId, proposalId, expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(schedule).not.toHaveBeenCalled();

    repository.getEngagementProposal.mockResolvedValueOnce(proposal());
    schedule.mockRejectedValueOnce(new Error('grant, ancestry, or reply window changed'));
    await expect(
      scheduleInstagramUnifiedProposal(
        {} as never,
        { unified: { schedule } },
        { workspaceId, userId, proposalId, expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('requires a Unified scheduler so approval cannot fall through to an immediate send', async () => {
    repository.getEngagementProposal.mockResolvedValueOnce(proposal());
    await expect(
      scheduleInstagramUnifiedProposal(
        {} as never,
        {},
        { workspaceId, userId, proposalId, expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
