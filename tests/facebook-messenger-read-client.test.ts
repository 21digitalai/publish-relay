import { describe, expect, it, vi } from 'vitest';

import {
  FacebookHttpClient,
  FacebookRequestError,
} from '../src/modules/providers/facebook-http-client.js';

const clientWith = (request: typeof fetch) =>
  new FacebookHttpClient({ graphVersion: 'v26.0', fetch: request });

describe('Facebook Messenger read transport', () => {
  it('lists Page conversations using bounded cursor pagination, without leaking provider URLs', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [{ id: 't_123', updated_time: '2026-10-25T02:00:00+0000', ignored: 'private' }],
        paging: {
          cursors: { after: 'next-cursor' },
          next: 'https://graph.facebook.com/secret?access_token=private',
        },
      }),
    );
    const result = await clientWith(request).listPageConversations({
      pageId: '123',
      accessToken: 'page-token',
      after: 'prior-cursor',
      limit: 20,
    });
    const target = request.mock.calls[0]?.[0];
    if (!(target instanceof URL)) throw new Error('Expected Graph URL');
    expect(target.pathname).toBe('/v26.0/123/conversations');
    expect(target.searchParams.get('after')).toBe('prior-cursor');
    expect(target.searchParams.get('limit')).toBe('20');
    expect(result).toEqual({
      conversations: [{ id: 't_123', updatedAt: '2026-10-25T02:00:00+0000' }],
      nextCursor: 'next-cursor',
    });
    expect(JSON.stringify(result)).not.toMatch(/private|access_token/);
  });

  it('reads messages without marking them read or exposing sender profile fields', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          {
            id: 'mid_456',
            message: 'Hello',
            created_time: '2026-10-25T02:01:00+0000',
            from: { id: 'psid_789', name: 'Private Person', email: 'hidden@example.test' },
          },
        ],
      }),
    );
    const result = await clientWith(request).listConversationMessages({
      conversationId: 't_123',
      accessToken: 'page-token',
    });
    expect(request.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(result).toEqual({
      messages: [
        {
          id: 'mid_456',
          text: 'Hello',
          createdAt: '2026-10-25T02:01:00+0000',
          senderId: 'psid_789',
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/Private Person|hidden@example/);
  });

  it('rejects path or page manipulation and classifies rate-limit denial', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: { code: 613, message: 'private provider body' } }, { status: 429 }),
      );
    const client = clientWith(request);
    await expect(
      client.listConversationMessages({ conversationId: '../other', accessToken: 'token' }),
    ).rejects.toThrow();
    await expect(
      client.listPageConversations({ pageId: '123', accessToken: 'token', limit: 101 }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    const error = await client
      .listPageConversations({ pageId: '123', accessToken: 'token' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FacebookRequestError);
    expect(error).toMatchObject({ evidence: { status: 429, kind: 'rate_limit' } });
    expect(String(error)).not.toContain('private provider body');
  });
});
