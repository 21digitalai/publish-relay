import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sendAccountPageCommentReply } from '../src/modules/providers/facebook-comment-send.service.js';

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  find: vi.fn(),
  reserve: vi.fn(),
  settle: vi.fn(),
  tenant: vi.fn(),
  policy: vi.fn(),
}));
vi.mock('../src/modules/providers/facebook-page-read-context.service.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  withPageReadToken: mocks.token,
}));
vi.mock('../src/modules/providers/facebook-comment-action.repository.js', () => ({
  findFacebookCommentAction: mocks.find,
  reserveFacebookCommentAction: mocks.reserve,
  settleFacebookCommentAction: mocks.settle,
}));
vi.mock('../src/database/tenant-transaction.js', () => ({ withTenantTransaction: mocks.tenant }));
vi.mock('../src/modules/policy/action-policy.js', () => ({ enforceWorkspaceAction: mocks.policy }));

const input = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  postId: '123_456',
  commentId: '123_456_789',
  clientActionId: '00000000-0000-4000-8000-000000000003',
  text: 'Hello',
  actor: { type: 'api-key' as const, id: '00000000-0000-4000-8000-000000000004' },
};

function runtime() {
  return {
    database: {} as never,
    keys: {} as never,
    policy: {} as never,
    client: {
      getPostOwner: vi.fn().mockResolvedValue('123'),
      isCommentUnderPost: vi.fn().mockResolvedValue(true),
      replyToComment: vi.fn().mockResolvedValue('reply_9'),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenant.mockImplementation(
    (_db: unknown, _input: unknown, callback: (tx: unknown) => Promise<unknown>) => callback({}),
  );
  mocks.token.mockImplementation(
    (
      _runtime: unknown,
      _input: unknown,
      callback: (pageId: string, token: string) => Promise<unknown>,
    ) => callback('123', 'server-token'),
  );
  mocks.find.mockResolvedValue(null);
  mocks.reserve.mockResolvedValue({ kind: 'new', id: '00000000-0000-4000-8000-000000000005' });
});

describe('Facebook Page comment reply command', () => {
  it('sends once under the selected Page post and records confirmation', async () => {
    const client = runtime();
    await expect(sendAccountPageCommentReply(client as never, input)).resolves.toEqual({
      state: 'confirmed',
      commentId: 'reply_9',
    });
    expect(client.client.replyToComment).toHaveBeenCalledWith({
      commentId: input.commentId,
      text: 'Hello',
      accessToken: 'server-token',
    });
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: { state: 'confirmed', commentId: 'reply_9' } }),
    );
  });

  it('rejects a foreign Page before reservation or send', async () => {
    const client = runtime();
    client.client.getPostOwner.mockResolvedValue('999');
    await expect(sendAccountPageCommentReply(client as never, input)).rejects.toThrow(
      'unavailable',
    );
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(client.client.replyToComment).not.toHaveBeenCalled();
  });

  it('rejects a comment outside the selected post', async () => {
    const client = runtime();
    client.client.isCommentUnderPost.mockResolvedValue(false);
    await expect(sendAccountPageCommentReply(client as never, input)).rejects.toThrow(
      'unavailable',
    );
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('replays reserved/ambiguous outcomes without a second provider call', async () => {
    mocks.find.mockResolvedValue({ kind: 'existing', outcome: { state: 'unknown' } });
    const client = runtime();
    await expect(sendAccountPageCommentReply(client as never, input)).resolves.toEqual({
      state: 'unknown',
    });
    expect(client.client.replyToComment).not.toHaveBeenCalled();
  });

  it('records a lost provider response as unknown', async () => {
    const client = runtime();
    client.client.replyToComment.mockRejectedValue(new Error('lost response'));
    await expect(sendAccountPageCommentReply(client as never, input)).resolves.toEqual({
      state: 'unknown',
    });
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: { state: 'unknown' } }),
    );
  });

  it('requires the send-specific provider scope', async () => {
    const client = runtime();
    await sendAccountPageCommentReply(client as never, input);
    expect(mocks.token).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        module: 'comments',
        additionalScopes: ['pages_read_user_content', 'pages_manage_engagement'],
        additionalTasks: ['MODERATE'],
      }),
      expect.any(Function),
    );
  });
});
