import { describe, expect, it, vi } from 'vitest';

import {
  listAccountPostComments,
  readScheduledCommentTarget,
} from '../src/modules/providers/facebook-comments-read.service.js';

const mocks = vi.hoisted(() => ({ tokenBoundary: vi.fn() }));
vi.mock('../src/modules/providers/facebook-page-read-context.service.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  withPageReadToken: mocks.tokenBoundary,
}));

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const input = { workspaceId, accountId, postId: '123_456', limit: 10 };

describe('Facebook selected-post comments read', () => {
  it('rechecks post ancestry and selected Page grant before a scheduled reply', async () => {
    const getPostOwner = vi.fn().mockResolvedValue('123');
    const isCommentUnderPost = vi.fn().mockResolvedValue(false);
    const readCommentThreadForReply = vi.fn();
    mocks.tokenBoundary.mockImplementation(
      async (
        _runtime: unknown,
        _input: unknown,
        read: (pageId: string, token: string) => Promise<unknown>,
      ) => read('123', 'server-held-token'),
    );
    const runtime = {
      database: {} as never,
      keys: {} as never,
      client: { getPostOwner, isCommentUnderPost, readCommentThreadForReply } as never,
    };
    const target = { workspaceId, accountId, postId: '123_456', commentId: '123_456_789' };
    await expect(readScheduledCommentTarget(runtime, target)).rejects.toThrow('unavailable');
    expect(readCommentThreadForReply).not.toHaveBeenCalled();
    expect(mocks.tokenBoundary).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        module: 'comments',
        additionalScopes: ['pages_read_user_content', 'pages_manage_engagement'],
        additionalTasks: ['MODERATE'],
      }),
      expect.any(Function),
    );
    isCommentUnderPost.mockResolvedValue(true);
    readCommentThreadForReply.mockResolvedValue({
      text: 'Current text',
      createdAt: '2026-11-10T12:00:00+0000',
      hasPageReply: false,
      threadFingerprint: 'fingerprint',
    });
    await expect(readScheduledCommentTarget(runtime, target)).resolves.toMatchObject({
      hasPageReply: false,
    });
    expect(readCommentThreadForReply).toHaveBeenCalledWith({
      pageId: '123',
      commentId: target.commentId,
      accessToken: 'server-held-token',
    });
  });
  it('rejects foreign Page posts before reading any visitor comments', async () => {
    const getPostOwner = vi.fn().mockResolvedValue('999');
    const listPostComments = vi.fn();
    mocks.tokenBoundary.mockImplementation(
      async (
        _runtime: unknown,
        _input: unknown,
        read: (pageId: string, token: string) => Promise<unknown>,
      ) => read('123', 'server-held-token'),
    );
    await expect(
      listAccountPostComments(
        {
          database: {} as never,
          keys: {} as never,
          client: { getPostOwner, listPostComments } as never,
        },
        input,
      ),
    ).rejects.toThrow('unavailable');
    expect(listPostComments).not.toHaveBeenCalled();
    expect(mocks.tokenBoundary).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        module: 'comments',
        additionalScopes: ['pages_read_user_content'],
      }),
      expect.any(Function),
    );
  });

  it('reads only after Graph identifies the selected Page as post owner', async () => {
    const getPostOwner = vi.fn().mockResolvedValue('123');
    const listPostComments = vi.fn().mockResolvedValue({ comments: [], nextCursor: null });
    mocks.tokenBoundary.mockImplementation(
      async (
        _runtime: unknown,
        _input: unknown,
        read: (pageId: string, token: string) => Promise<unknown>,
      ) => read('123', 'server-held-token'),
    );
    const result = await listAccountPostComments(
      {
        database: {} as never,
        keys: {} as never,
        client: { getPostOwner, listPostComments } as never,
      },
      input,
    );
    expect(result).toEqual({ comments: [], nextCursor: null });
    expect(getPostOwner).toHaveBeenCalledWith('123_456', 'server-held-token');
    expect(listPostComments).toHaveBeenCalledWith({
      postId: '123_456',
      accessToken: 'server-held-token',
      limit: 10,
    });
  });
});
