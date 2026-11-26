import { describe, expect, it } from 'vitest';
import { InstagramUnifiedReadClient } from '../src/modules/providers/instagram-unified-read-client.js';

describe('Instagram Unified read client', () => {
  it('reads account media with bounded pagination and an allowlisted response', async () => {
    const requests: URL[] = [];
    const client = new InstagramUnifiedReadClient({
      graphVersion: 'v27.0',
      fetch: (input) => {
        const url =
          input instanceof URL
            ? input
            : typeof input === 'string'
              ? new URL(input)
              : new URL(input.url);
        requests.push(url);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'm1',
                  media_type: 'IMAGE',
                  timestamp: '2026-11-26T10:00:00+0000',
                  caption: 'hello',
                  comments_count: 2,
                },
              ],
              paging: {},
            }),
            { status: 200 },
          ),
        );
      },
    });
    await expect(
      client.listMedia({ accountId: 'ig1', accessToken: 'secret', limit: 10 }),
    ).resolves.toEqual({
      media: [
        {
          id: 'm1',
          type: 'IMAGE',
          url: null,
          permalink: null,
          timestamp: '2026-11-26T10:00:00+0000',
          caption: 'hello',
          commentsCount: 2,
        },
      ],
      nextCursor: null,
    });
    expect(requests[0]?.pathname).toBe('/v27.0/ig1/media');
    expect(requests[0]?.searchParams.get('fields')).toContain('comments_count');
  });

  it('replays only the opaque provider cursor and never returns a paging URL', async () => {
    const requests: URL[] = [];
    let pageNumber = 0;
    const client = new InstagramUnifiedReadClient({
      graphVersion: 'v27.0',
      fetch: (input) => {
        const url =
          input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
        requests.push(url);
        pageNumber += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  id: `m${String(pageNumber)}`,
                  media_type: 'IMAGE',
                  timestamp: '2026-11-26T10:00:00+0000',
                },
              ],
              paging:
                pageNumber === 1
                  ? {
                      next: 'https://graph.facebook.com/v27.0/ig1/media?access_token=secret&after=cursor-1',
                      cursors: { after: 'cursor-1' },
                    }
                  : {},
            }),
            { status: 200 },
          ),
        );
      },
    });

    await expect(
      client.listMedia({ accountId: 'ig1', accessToken: 'secret', limit: 10 }),
    ).resolves.toMatchObject({
      media: [{ id: 'm1' }, { id: 'm2' }],
      nextCursor: null,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.searchParams.get('after')).toBe('cursor-1');
    expect(requests[1]?.search).not.toContain('access_token');
  });

  it('stops at the twenty-page cap and returns the safe cursor for continuation', async () => {
    let calls = 0;
    const client = new InstagramUnifiedReadClient({
      graphVersion: 'v27.0',
      fetch: () => {
        calls += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  id: `m${String(calls)}`,
                  media_type: 'IMAGE',
                  timestamp: '2026-11-26T10:00:00+0000',
                },
              ],
              paging: {
                next: 'https://graph.facebook.com/next?access_token=secret',
                cursors: { after: `cursor-${String(calls)}` },
              },
            }),
            { status: 200 },
          ),
        );
      },
    });

    await expect(
      client.listMedia({ accountId: 'ig1', accessToken: 'secret' }),
    ).resolves.toMatchObject({
      media: { length: 20 },
      nextCursor: 'cursor-20',
    });
    expect(calls).toBe(20);
  });

  it('returns truthful verified, missing, and declined grant states', async () => {
    const responses = [
      {
        data: [
          { permission: 'instagram_basic', status: 'granted' },
          { permission: 'instagram_manage_comments', status: 'declined' },
        ],
      },
      { data: [{ permission: 'instagram_basic', status: 'granted' }] },
    ];
    const client = new InstagramUnifiedReadClient({
      graphVersion: 'v27.0',
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify(responses.shift()), { status: 200 })),
    });
    await expect(client.verifyPermissions('secret')).resolves.toEqual({
      instagram_basic: 'granted',
      instagram_manage_comments: 'declined',
    });
    await expect(client.verifyPermissions('secret')).resolves.toEqual({
      instagram_basic: 'granted',
      instagram_manage_comments: 'missing',
    });
  });

  it('does not turn an invalid permission response into a connected state', async () => {
    const client = new InstagramUnifiedReadClient({
      graphVersion: 'v27.0',
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [{ permission: 'instagram_basic' }] }), {
            status: 200,
          }),
        ),
    });
    await expect(client.verifyPermissions('secret')).rejects.toMatchObject({
      kind: 'permanent',
      status: 502,
    });
  });

  it('keeps messaging reads unavailable when the separate grant is missing or declined', async () => {
    const responses = [
      { data: [{ permission: 'instagram_basic', status: 'granted' }] },
      { data: [{ permission: 'instagram_manage_messages', status: 'declined' }] },
    ];
    const client = new InstagramUnifiedReadClient({
      graphVersion: 'v27.0',
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify(responses.shift()), { status: 200 })),
    });
    await expect(client.verifyMessagingPermission('secret')).resolves.toBe('missing');
    await expect(client.verifyMessagingPermission('secret')).resolves.toBe('declined');
  });

  it('reads comments and rejects provider permission failures without leaking body text', async () => {
    const client = new InstagramUnifiedReadClient({
      graphVersion: 'v27.0',
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ id: 'media1', owner: { id: 'different-account' } }), {
            status: 200,
          }),
        ),
    });
    await expect(
      client.listComments({ accountId: 'old-account', mediaId: 'media1', accessToken: 'secret' }),
    ).rejects.toMatchObject({
      kind: 'permission',
      status: 403,
    });
  });

  it('reads conversations and proves conversation ancestry before messages', async () => {
    const paths: string[] = [];
    const client = new InstagramUnifiedReadClient({
      graphVersion: 'v27.0',
      fetch: (input) => {
        const url =
          input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
        paths.push(url.pathname);
        const body = url.pathname.endsWith('/permissions')
          ? { data: [{ permission: 'instagram_manage_messages', status: 'granted' }] }
          : url.pathname.endsWith('/conversations')
            ? {
                data: [
                  {
                    id: 'c1',
                    updated_time: '2026-11-26T10:00:00+0000',
                    participants: { data: [{ id: 'ig1', username: 'relay' }] },
                  },
                ],
                paging: {},
              }
            : url.pathname.endsWith('/messages')
              ? {
                  data: [
                    {
                      id: 'msg1',
                      created_time: '2026-11-26T10:01:00+0000',
                      from: { id: 'u1' },
                      message: 'hi',
                    },
                  ],
                  paging: {},
                }
              : { id: 'c1', participants: { data: [{ id: 'ig1' }] } };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      },
    });
    await expect(
      client.listConversations({ accountId: 'ig1', accessToken: 'secret' }),
    ).resolves.toMatchObject({ conversations: [{ id: 'c1' }] });
    await expect(
      client.listMessages({ accountId: 'ig1', conversationId: 'c1', accessToken: 'secret' }),
    ).resolves.toEqual({
      messages: [
        {
          id: 'msg1',
          createdAt: '2026-11-26T10:01:00+0000',
          senderId: 'u1',
          senderUsername: null,
          text: 'hi',
        },
      ],
      nextCursor: null,
    });
    expect(paths).toContain('/v27.0/c1');
  });

  it.each([
    [401, 190, 'auth'],
    [403, 10, 'permission'],
    [400, 100, 'validation'],
    [429, 4, 'rate_limit'],
    [503, undefined, 'transient'],
  ] as const)('preserves safe provider error kind for %s responses', async (status, code, kind) => {
    const client = new InstagramUnifiedReadClient({
      graphVersion: 'v27.0',
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code, message: 'secret provider body' } }), {
            status,
          }),
        ),
    });
    await expect(client.verifyPermissions('secret')).rejects.toMatchObject({ kind, status });
    await expect(client.verifyPermissions('secret')).rejects.not.toThrow('secret provider body');
  });
});
