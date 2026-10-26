import { describe, expect, it, vi } from 'vitest';
import {
  FacebookHttpClient,
  FacebookRequestError,
} from '../src/modules/providers/facebook-http-client.js';

describe('Facebook comment reply Graph boundary', () => {
  it('posts text to the exact comment with the Page token and returns only a confirmed ID', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: '123_456_900' }), { status: 200 }));
    const client = new FacebookHttpClient({ graphVersion: 'v23.0', fetch });
    await expect(
      client.replyToComment({ commentId: '123_456_789', text: 'Hello', accessToken: 'secret' }),
    ).resolves.toBe('123_456_900');
    const [url, request] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://graph.facebook.com/v23.0/123_456_789/comments');
    expect(request.headers).toMatchObject({ authorization: 'Bearer secret' });
    expect((request.body as URLSearchParams).toString()).toBe('message=Hello');
  });

  it('treats malformed success and lost response as unknown', async () => {
    const client = new FacebookHttpClient({
      graphVersion: 'v23.0',
      fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    });
    await expect(
      client.replyToComment({ commentId: '123_456_789', text: 'Hello', accessToken: 'secret' }),
    ).rejects.toMatchObject({ outcomeUnknown: true });
    const failing = new FacebookHttpClient({
      graphVersion: 'v23.0',
      fetch: vi.fn().mockRejectedValue(new Error('disconnect')),
    });
    await expect(
      failing.replyToComment({ commentId: '123_456_789', text: 'Hello', accessToken: 'secret' }),
    ).rejects.toBeInstanceOf(FacebookRequestError);
  });

  it('proves exact post ancestry and denies another post', async () => {
    const fetch = vi.fn().mockImplementation((url: URL) => {
      const id = url.pathname.split('/').pop();
      const parent = id === '123_456_789' ? '123_456_700' : '123_456';
      return Promise.resolve(
        new Response(JSON.stringify({ id, parent: { id: parent } }), { status: 200 }),
      );
    });
    const client = new FacebookHttpClient({ graphVersion: 'v23.0', fetch });
    await expect(client.isCommentUnderPost('123_456_789', '123_456', 'secret')).resolves.toBe(true);
    await expect(client.isCommentUnderPost('123_456_789', '999_888', 'secret')).resolves.toBe(
      false,
    );
  });
});
