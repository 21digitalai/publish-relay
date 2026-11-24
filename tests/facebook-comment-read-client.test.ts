import { describe, expect, it, vi } from 'vitest';

import {
  FacebookHttpClient,
  FacebookRequestError,
} from '../src/modules/providers/facebook-http-client.js';

const makeClient = (request: typeof fetch) =>
  new FacebookHttpClient({ graphVersion: 'v26.0', fetch: request });

const attachmentOnlyTargets: { label: string; message?: string }[] = [
  { label: 'blank', message: '' },
  { label: 'omitted' },
];

describe('Facebook Page comment read transport', () => {
  it.each(attachmentOnlyTargets)(
    'accepts an attachment-only target with a $label message',
    async ({ message }) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({
            id: '123_456_789',
            ...(message === undefined ? {} : { message }),
            created_time: '2026-11-10T12:00:00+0000',
          }),
        )
        .mockResolvedValueOnce(Response.json({ data: [] }));

      const result = await makeClient(request).readCommentThreadForReply({
        pageId: '123',
        commentId: '123_456_789',
        accessToken: 'token',
      });
      expect(result).toMatchObject({
        text: '',
        createdAt: '2026-11-10T12:00:00+0000',
        hasPageReply: false,
      });
      expect(result.threadFingerprint).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it('rejects a malformed target message instead of treating it as attachment-only', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        id: '123_456_789',
        message: null,
        created_time: '2026-11-10T12:00:00+0000',
      }),
    );

    await expect(
      makeClient(request).readCommentThreadForReply({
        pageId: '123',
        commentId: '123_456_789',
        accessToken: 'token',
      }),
    ).rejects.toBeInstanceOf(FacebookRequestError);
    expect(request).toHaveBeenCalledOnce();
  });

  it('re-reads current target and detects a Page reply across pagination', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          id: '123_456_789',
          message: 'Current text',
          created_time: '2026-11-10T12:00:00+0000',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: '11', from: { id: 'visitor' } }],
          paging: { next: 'private-url', cursors: { after: 'page-2' } },
        }),
      )
      .mockResolvedValueOnce(Response.json({ data: [{ id: '12', from: { id: '123' } }] }));
    // Graph author IDs are numeric; a malformed author must fail closed.
    await expect(
      makeClient(request).readCommentThreadForReply({
        pageId: '123',
        commentId: '123_456_789',
        accessToken: 'token',
      }),
    ).rejects.toBeInstanceOf(FacebookRequestError);
    const valid = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          id: '123_456_789',
          message: 'Current text',
          created_time: '2026-11-10T12:00:00+0000',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: '11', from: { id: '456' } }],
          paging: { next: 'private-url', cursors: { after: 'page-2' } },
        }),
      )
      .mockResolvedValueOnce(Response.json({ data: [{ id: '12', from: { id: '123' } }] }));
    expect(
      await makeClient(valid).readCommentThreadForReply({
        pageId: '123',
        commentId: '123_456_789',
        accessToken: 'token',
      }),
    ).toEqual({
      text: 'Current text',
      createdAt: '2026-11-10T12:00:00+0000',
      hasPageReply: true,
      threadFingerprint: null,
    });
    const third = valid.mock.calls[2]?.[0];
    if (!(third instanceof URL)) throw new Error('Expected Graph URL');
    expect(third.searchParams.get('after')).toBe('page-2');
    expect(third.toString()).not.toContain('token');
  });

  it('fails closed when a reply author or terminal pagination proof is missing', async () => {
    const missingAuthor = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: '9', message: 'Hello', created_time: '2026-11-10T12:00:00+0000' }),
      )
      .mockResolvedValueOnce(Response.json({ data: [{ id: '10' }] }));
    await expect(
      makeClient(missingAuthor).readCommentThreadForReply({
        pageId: '1',
        commentId: '9',
        accessToken: 'token',
      }),
    ).rejects.toBeInstanceOf(FacebookRequestError);
    const noCursor = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: '9', message: 'Hello', created_time: '2026-11-10T12:00:00+0000' }),
      )
      .mockResolvedValueOnce(Response.json({ data: [], paging: { next: 'private-url' } }));
    await expect(
      makeClient(noCursor).readCommentThreadForReply({
        pageId: '1',
        commentId: '9',
        accessToken: 'token',
      }),
    ).rejects.toBeInstanceOf(FacebookRequestError);
    const eligible = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: '9', message: 'Hello', created_time: '2026-11-10T12:00:00+0000' }),
      )
      .mockResolvedValueOnce(Response.json({ data: [{ id: '10', from: { id: '2' } }] }));
    const snapshot = await makeClient(eligible).readCommentThreadForReply({
      pageId: '1',
      commentId: '9',
      accessToken: 'token',
    });
    expect(snapshot.hasPageReply).toBe(false);
    expect(snapshot.threadFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
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

  it('projects the authoritative post author for Page ownership without exposing profile fields', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: '123_456',
        from: { id: '123', name: 'Private Page Label', access_token: 'private' },
      }),
    );
    const owner = await makeClient(request).getPostOwner('123_456', 'page-token');
    expect(owner).toBe('123');
    const url = request.mock.calls[0]?.[0];
    if (!(url instanceof URL)) throw new Error('Expected Graph URL');
    expect(url.searchParams.get('fields')).toBe('id,from{id}');
  });

  it('fails closed when Graph cannot attest the selected post author', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: '123_456' }));
    await expect(makeClient(request).getPostOwner('123_456', 'page-token')).rejects.toThrow();
  });

  it('does not advertise a terminal cursor for posts or comments', async () => {
    const terminalPage = () =>
      Response.json({ data: [], paging: { cursors: { after: 'terminal-cursor' } } });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(terminalPage())
      .mockResolvedValueOnce(terminalPage());
    const client = makeClient(request);
    expect(
      (await client.listPagePosts({ pageId: '123', accessToken: 'token' })).nextCursor,
    ).toBeNull();
    expect(
      (await client.listPostComments({ postId: '123_456', accessToken: 'token' })).nextCursor,
    ).toBeNull();
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

  it.each([
    [403, 4],
    [429, 613],
  ])('classifies HTTP %i Meta code %i as rate limited', async (status, code) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: { code, message: 'private provider detail' } }, { status }),
      );
    const error = await makeClient(request)
      .listPagePosts({ pageId: '123', accessToken: 'token' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FacebookRequestError);
    expect(error).toMatchObject({ evidence: { status, kind: 'rate_limit' } });
    expect(String(error)).not.toContain('private provider detail');
  });
});
