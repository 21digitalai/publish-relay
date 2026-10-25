import { describe, expect, it, vi } from 'vitest';

import {
  FacebookHttpClient,
  FacebookRequestError,
} from '../src/modules/providers/facebook-http-client.js';

const makeClient = (request: typeof fetch) =>
  new FacebookHttpClient({ graphVersion: 'v26.0', fetch: request });

describe('Facebook Page comment read transport', () => {
  it('bounds Page-owned posts and returns only a safe cursor and allowlisted fields', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          {
            id: '123_456',
            message: 'Page post',
            created_time: '2026-10-25T01:00:00+0000',
            permalink_url: 'https://www.facebook.com/123/posts/456',
            access_token: 'must-not-leak',
          },
        ],
        paging: {
          cursors: { after: 'cursor-two' },
          next: 'https://graph.facebook.com/private?access_token=must-not-leak',
        },
      }),
    );
    const page = await makeClient(request).listPagePosts({
      pageId: '123',
      accessToken: 'private-page-token',
      limit: 10,
      after: 'cursor-one',
    });
    const url = request.mock.calls[0]?.[0];
    expect(url).toBeInstanceOf(URL);
    if (!(url instanceof URL)) throw new Error('Expected Graph URL');
    expect(url.pathname).toBe('/v26.0/123/posts');
    expect(url.searchParams.get('after')).toBe('cursor-one');
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer private-page-token',
    });
    expect(page).toEqual({
      posts: [
        {
          id: '123_456',
          text: 'Page post',
          createdAt: '2026-10-25T01:00:00+0000',
          permalink: 'https://www.facebook.com/123/posts/456',
        },
      ],
      nextCursor: 'cursor-two',
    });
    expect(JSON.stringify(page)).not.toContain('must-not-leak');
  });

  it('projects comments and counts without provider metadata or read side effects', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          {
            id: '123_456_789',
            message: 'Visitor comment',
            created_time: '2026-10-25T01:02:00+0000',
            comment_count: 2,
            like_count: 3,
            from: { id: 'private-profile', name: 'Private Person' },
          },
        ],
      }),
    );
    const page = await makeClient(request).listPostComments({
      postId: '123_456',
      accessToken: 'page-token',
    });
    expect(request.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(page).toEqual({
      comments: [
        {
          id: '123_456_789',
          text: 'Visitor comment',
          createdAt: '2026-10-25T01:02:00+0000',
          replyCount: 2,
          likeCount: 3,
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(page)).not.toContain('Private Person');
  });

  it('rejects unbounded requests and classifies provider permission/rate failures', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { code: 200, message: 'private provider detail' } },
          { status: 403 },
        ),
      );
    const client = makeClient(request);
    await expect(
      client.listPagePosts({ pageId: '123', accessToken: 'token', limit: 101 }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    const permission = await client
      .listPostComments({ postId: '123_456', accessToken: 'token' })
      .catch((error: unknown) => error);
    expect(permission).toBeInstanceOf(FacebookRequestError);
    expect(permission).toMatchObject({ evidence: { status: 403, kind: 'permission' } });
    expect(String(permission)).not.toContain('private provider detail');
  });
});
