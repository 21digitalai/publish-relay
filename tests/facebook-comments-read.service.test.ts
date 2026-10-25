import { describe, expect, it, vi } from 'vitest';

import { listAccountPostComments } from '../src/modules/providers/facebook-comments-read.service.js';

const mocks = vi.hoisted(() => ({ tokenBoundary: vi.fn() }));
vi.mock('../src/modules/providers/facebook-page-read-context.service.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  withPageReadToken: mocks.tokenBoundary,
}));

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const input = { workspaceId, accountId, postId: '123_456', limit: 10 };

describe('Facebook selected-post comments read', () => {
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
