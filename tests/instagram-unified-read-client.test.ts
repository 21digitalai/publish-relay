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
});
