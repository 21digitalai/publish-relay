import { describe, expect, it, vi } from 'vitest';
import { readBoundedCommentPages } from '../src/modules/providers/facebook-comment-pages.js';
const input = { postId: '123_456', accessToken: 'secret', maxPages: 2 };
describe('invocation-local comment pagination', () => {
  it('includes new comments on old posts and returns explicit continuation at the page bound', async () => {
    const listPostComments = vi
      .fn()
      .mockResolvedValueOnce({
        comments: [{ id: '1', text: 'new comment on old post' }],
        nextCursor: 'opaque',
      })
      .mockResolvedValueOnce({ comments: [{ id: '2' }], nextCursor: 'later' });
    const result = await readBoundedCommentPages({ listPostComments } as never, input);
    expect(result).toMatchObject({
      complete: false,
      nextCursor: 'later',
      stopReason: 'page_limit',
      reads: { ownerReads: 1, commentPageReads: 2 },
    });
    expect(result.comments).toHaveLength(2);
    expect(listPostComments.mock.calls[1]?.[0]).toMatchObject({
      after: 'opaque',
      limit: 100,
      requireCompleteCursor: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|accessToken|postId/);
  });
  it('declares exhaustion only with explicit terminal cursor', async () => {
    const listPostComments = vi.fn().mockResolvedValue({ comments: [], nextCursor: null });
    expect(await readBoundedCommentPages({ listPostComments } as never, input)).toMatchObject({
      complete: true,
      nextCursor: null,
      stopReason: 'exhausted',
    });
    expect(listPostComments).toHaveBeenCalledTimes(1);
  });
  it.each(['repeat', 'missing', 'revoked'])(
    'fails closed on %s without exposing partial rows',
    async (kind) => {
      const listPostComments = vi
        .fn()
        .mockResolvedValueOnce({ comments: [{ id: '1' }], nextCursor: 'same' });
      if (kind === 'revoked') listPostComments.mockRejectedValueOnce(new Error('revoked'));
      else
        listPostComments.mockResolvedValueOnce({
          comments: [],
          ...(kind === 'repeat' ? { nextCursor: 'same' } : {}),
        });
      await expect(readBoundedCommentPages({ listPostComments } as never, input)).rejects.toThrow();
      expect(listPostComments).toHaveBeenCalledTimes(2);
    },
  );
  it('bounds bytes without losing the first unaccepted page cursor', async () => {
    const listPostComments = vi
      .fn()
      .mockResolvedValueOnce({ comments: [{ id: '1' }], nextCursor: 'resume' })
      .mockResolvedValueOnce({
        comments: [{ id: '2', text: 'x'.repeat(1024 * 1024) }],
        nextCursor: null,
      });
    const result = await readBoundedCommentPages({ listPostComments } as never, input);
    expect(result).toMatchObject({
      complete: false,
      nextCursor: 'resume',
      stopReason: 'byte_limit',
      reads: { commentPageReads: 2 },
    });
    expect(result.comments).toEqual([{ id: '1' }]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(512);
  });
});
