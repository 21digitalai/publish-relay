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

  it('proves a parentless top-level comment through the selected post edge across pages', async () => {
    const fetch = vi.fn().mockImplementation((url: URL) => {
      const path = url.pathname;
      const body = path.endsWith('/comments')
        ? url.searchParams.has('after')
          ? { data: [{ id: '123_456_789' }] }
          : { data: [{ id: '123_456_700' }], paging: { next: 'next', cursors: { after: 'c1' } } }
        : { id: '123_456_789' };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    const client = new FacebookHttpClient({ graphVersion: 'v23.0', fetch });
    await expect(client.isCommentUnderPost('123_456_789', '123_456', 'secret')).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((fetch.mock.calls[2]?.[0] as URL).searchParams.get('after')).toBe('c1');
    expect((fetch.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer secret',
    });
  });

  it('denies parentless comments absent from the selected post, including malformed pagination', async () => {
    const fetch = vi.fn().mockImplementation((url: URL) => {
      const body = url.pathname.endsWith('/comments')
        ? { data: [{ id: '999_888_777' }], paging: { next: 'next' } }
        : { id: '123_456_789' };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    const client = new FacebookHttpClient({ graphVersion: 'v23.0', fetch });
    await expect(client.isCommentUnderPost('123_456_789', '123_456', 'secret')).resolves.toBe(
      false,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('proves a nested reply only when its parentless ancestor is on the selected post', async () => {
    const fetch = vi.fn().mockImplementation((url: URL) => {
      const path = url.pathname;
      const body = path.endsWith('/comments')
        ? { data: path.includes('/123_456/') ? [{ id: '123_456_700' }] : [] }
        : path.endsWith('123_456_789')
          ? { id: '123_456_789', parent: { id: '123_456_700' } }
          : { id: '123_456_700' };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    const client = new FacebookHttpClient({ graphVersion: 'v23.0', fetch });
    await expect(client.isCommentUnderPost('123_456_789', '123_456', 'secret')).resolves.toBe(true);
    await expect(client.isCommentUnderPost('123_456_789', '999_888', 'secret')).resolves.toBe(
      false,
    );
  });

  it('denies malformed comment identity and cyclic ancestry without edge proof', async () => {
    const fetch = vi.fn().mockImplementation((url: URL) => {
      const id = url.pathname.split('/').pop();
      return Promise.resolve(new Response(JSON.stringify({ id, parent: { id } }), { status: 200 }));
    });
    const client = new FacebookHttpClient({ graphVersion: 'v23.0', fetch });
    await expect(client.isCommentUnderPost('123_456_789', '123_456', 'secret')).resolves.toBe(
      false,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('denies malformed Graph comment data and stops proof at the pagination bound', async () => {
    const malformed = new FacebookHttpClient({
      graphVersion: 'v23.0',
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'wrong' }))),
    });
    await expect(malformed.isCommentUnderPost('123_456_789', '123_456', 'secret')).resolves.toBe(
      false,
    );

    let page = 0;
    const fetch = vi.fn().mockImplementation((url: URL) => {
      if (!url.pathname.endsWith('/comments')) {
        return Promise.resolve(new Response(JSON.stringify({ id: '123_456_789' })));
      }
      page += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: '999_888_777' }],
            paging: { next: 'next', cursors: { after: `cursor-${String(page)}` } },
          }),
        ),
      );
    });
    const bounded = new FacebookHttpClient({ graphVersion: 'v23.0', fetch });
    await expect(bounded.isCommentUnderPost('123_456_789', '123_456', 'secret')).resolves.toBe(
      false,
    );
    expect(page).toBe(10);
  });
});
