import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findFacebookCommentAction } from '../src/modules/providers/facebook-comment-action.repository.js';
import {
  claimDuePageComment,
  finishClaimedPageComment,
} from '../src/modules/providers/facebook-comment-pending.repository.js';
import { dispatchDuePageComments } from '../src/modules/providers/facebook-comment-pending.worker.js';
import { sendAccountPageCommentReply } from '../src/modules/providers/facebook-comment-send.service.js';
import { readScheduledCommentTarget } from '../src/modules/providers/facebook-comments-read.service.js';
import { authorizePageEngagement } from '../src/modules/providers/facebook-page-engagement.service.js';

vi.mock('../src/modules/providers/facebook-comment-action.repository.js', () => ({
  findFacebookCommentAction: vi.fn(),
}));
vi.mock('../src/modules/providers/facebook-comment-pending.repository.js', () => ({
  claimDuePageComment: vi.fn(),
  finishClaimedPageComment: vi.fn(),
  renewClaimedPageComment: vi.fn(),
}));
vi.mock('../src/modules/providers/facebook-comment-send.service.js', () => ({
  sendAccountPageCommentReply: vi.fn(),
}));
vi.mock('../src/modules/providers/facebook-comments-read.service.js', () => ({
  readScheduledCommentTarget: vi.fn(),
}));
vi.mock('../src/modules/providers/facebook-page-engagement.service.js', () => ({
  authorizePageEngagement: vi.fn(),
}));

const intent = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  accountId: '00000000-0000-4000-8000-000000000003',
  postId: '123_456',
  commentId: '123_456_789',
  clientActionId: '00000000-0000-4000-8000-000000000004',
  actorType: 'api_key',
  actorId: '00000000-0000-4000-8000-000000000005',
  text: 'Reply',
  targetText: 'Original',
  targetCreatedAt: '2026-11-10T10:00:00+0000',
  threadFingerprint: 'a'.repeat(64),
  leaseOwner: 'worker:claim',
};
const runtime = {
  database: {} as never,
  keys: {} as never,
  client: {} as never,
  workerId: 'worker',
  leaseMs: 30_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(claimDuePageComment).mockResolvedValue(intent as never);
  vi.mocked(finishClaimedPageComment).mockResolvedValue(true);
  vi.mocked(findFacebookCommentAction).mockResolvedValue(null);
  vi.mocked(authorizePageEngagement).mockResolvedValue(true);
  vi.mocked(readScheduledCommentTarget).mockResolvedValue({
    text: intent.targetText,
    createdAt: intent.targetCreatedAt,
    hasPageReply: false,
    threadFingerprint: intent.threadFingerprint,
  });
  vi.mocked(sendAccountPageCommentReply).mockResolvedValue({
    state: 'confirmed',
    commentId: '456_789',
  });
});

describe('due Page comment dispatch', () => {
  it('sends only after fresh selected-Page context matches and settles confirmed', async () => {
    expect(await dispatchDuePageComments(runtime)).toMatchObject({ confirmed: 1 });
    expect(sendAccountPageCommentReply).toHaveBeenCalledOnce();
    expect(finishClaimedPageComment).toHaveBeenCalledWith(
      runtime.database,
      expect.objectContaining({ state: 'confirmed', leaseOwner: intent.leaseOwner }),
    );
  });

  it('dispatches when the unchanged attachment-only target remains textless', async () => {
    vi.mocked(claimDuePageComment).mockResolvedValue({ ...intent, targetText: '' } as never);
    vi.mocked(readScheduledCommentTarget).mockResolvedValue({
      text: '',
      createdAt: intent.targetCreatedAt,
      hasPageReply: false,
      threadFingerprint: intent.threadFingerprint,
    });

    expect(await dispatchDuePageComments(runtime)).toMatchObject({ confirmed: 1 });
    expect(sendAccountPageCommentReply).toHaveBeenCalledOnce();
  });

  it('suppresses a stale thread before provider send', async () => {
    vi.mocked(readScheduledCommentTarget).mockResolvedValue({
      text: intent.targetText,
      createdAt: intent.targetCreatedAt,
      hasPageReply: true,
      threadFingerprint: null,
    });
    expect(await dispatchDuePageComments(runtime)).toMatchObject({ failed: 1 });
    expect(sendAccountPageCommentReply).not.toHaveBeenCalled();
  });

  it('freezes unknown provider outcomes without retrying', async () => {
    vi.mocked(sendAccountPageCommentReply).mockResolvedValue({ state: 'unknown' });
    expect(await dispatchDuePageComments(runtime)).toMatchObject({ unknown: 1 });
    expect(finishClaimedPageComment).toHaveBeenCalledWith(
      runtime.database,
      expect.objectContaining({ state: 'unknown' }),
    );
  });

  it('never resends an already reserved action after restart', async () => {
    vi.mocked(findFacebookCommentAction).mockResolvedValue({
      kind: 'existing',
      outcome: { state: 'unknown' },
    });
    expect(await dispatchDuePageComments(runtime)).toMatchObject({ unknown: 1 });
    expect(readScheduledCommentTarget).not.toHaveBeenCalled();
    expect(sendAccountPageCommentReply).not.toHaveBeenCalled();
  });
});
