import { describe, expect, it, vi } from 'vitest';
import { listAccountPostComments } from '../src/modules/providers/facebook-comments-read.service.js';
vi.mock('../src/modules/providers/facebook-page-read-context.service.js', async (loadOriginal) => ({
  ...(await loadOriginal<object>()),
  withPageReadToken: (
    _runtime: unknown,
    _input: unknown,
    use: (page: string, token: string) => unknown,
  ) => use('123', 'secret'),
}));
const input = { workspaceId: 'w', accountId: 'a', postId: '123_456', maxPages: 2 };
describe('authorized multi-page comment invocation', () => {
  it('proves owner exactly once for two pages and repeats proof on continuation invocation', async () => {
    const getPostOwner = vi.fn().mockResolvedValue('123');
    const listPostComments = vi.fn().mockImplementation(({ after }: { after?: string }) =>
      Promise.resolve({
        comments: [],
        nextCursor: after === 'next' ? null : 'next',
      }),
    );
    const runtime = {
      database: {} as never,
      keys: {} as never,
      client: { getPostOwner, listPostComments } as never,
    };
    await listAccountPostComments(runtime, input);
    expect(getPostOwner).toHaveBeenCalledTimes(1);
    expect(listPostComments).toHaveBeenCalledTimes(2);
    await listAccountPostComments(runtime, { ...input, after: 'new' });
    expect(getPostOwner).toHaveBeenCalledTimes(2);
  });
  it('denies foreign posts before reading comments', async () => {
    const getPostOwner = vi.fn().mockResolvedValue('foreign');
    const listPostComments = vi.fn();
    await expect(
      listAccountPostComments(
        {
          database: {} as never,
          keys: {} as never,
          client: { getPostOwner, listPostComments } as never,
        },
        input,
      ),
    ).rejects.toThrow();
    expect(listPostComments).not.toHaveBeenCalled();
  });
});
