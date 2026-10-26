import { describe, expect, it, vi } from 'vitest';

import {
  FacebookHttpClient,
  FacebookRequestError,
} from '../src/modules/providers/facebook-http-client.js';

const clientWith = (request: typeof fetch) =>
  new FacebookHttpClient({ graphVersion: 'v26.0', fetch: request });

describe('Facebook Messenger read transport', () => {
  it('loads bounded participant identity without returning provider contact fields', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 't_123',
        participants: {
          data: [
            { id: '123', name: 'Page' },
            { id: 'psid_789', name: 'Birkan Reyhan', email: 'hidden@example.test' },
          ],
        },
      }),
    );
    const result = await clientWith(request).getConversationParticipants('t_123', 'page-token');
    const target = request.mock.calls[0]?.[0];
    if (!(target instanceof URL)) throw new Error('Expected Graph URL');
    expect(target.pathname).toBe('/v26.0/t_123');
    expect(target.searchParams.get('fields')).toBe('id,participants{id,name}');
    expect(result).toEqual([
      { id: '123', name: 'Page' },
      { id: 'psid_789', name: 'Birkan Reyhan' },
    ]);
    expect(JSON.stringify(result)).not.toContain('hidden@example');
  });

  it('keeps the send ownership preflight ID-only', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 't_123',
        participants: { data: [{ id: '123' }, { id: 'psid_789', name: 'Private Name' }] },
      }),
    );
    const result = await clientWith(request).getConversationParticipantIds('t_123', 'page-token');
    const target = request.mock.calls[0]?.[0];
    if (!(target instanceof URL)) throw new Error('Expected Graph URL');
    expect(target.searchParams.get('fields')).toBe('id,participants{id}');
    expect(result).toEqual(['123', 'psid_789']);
    expect(JSON.stringify(result)).not.toContain('Private Name');
  });

  it('fails closed when Graph omits participants or returns a different conversation', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 't_123' }))
      .mockResolvedValueOnce(
        Response.json({ id: 't_other', participants: { data: [{ id: '123' }, { id: 'psid_7' }] } }),
      );
    const client = clientWith(request);
    await expect(client.getConversationParticipants('t_123', 'token')).rejects.toMatchObject({
      evidence: { status: 502 },
    });
    await expect(client.getConversationParticipants('t_123', 'token')).rejects.toMatchObject({
      evidence: { status: 502 },
    });
  });

  it('lists Page conversations using bounded cursor pagination, without leaking provider URLs', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          {
            id: 't_123',
            updated_time: '2026-10-25T02:00:00+0000',
            participants: {
              data: [
                { id: '123', name: 'Page' },
                { id: 'psid_789', name: 'Birkan Reyhan', email: 'hidden@example.test' },
              ],
            },
            ignored: 'private',
          },
        ],
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
    expect(target.searchParams.get('fields')).toBe('id,updated_time,participants{id,name}');
    expect(result).toEqual({
      conversations: [
        { id: 't_123', updatedAt: '2026-10-25T02:00:00+0000', displayName: 'Birkan Reyhan' },
      ],
      nextCursor: 'next-cursor',
    });
    expect(JSON.stringify(result)).not.toMatch(/private|access_token|hidden@example/);
  });

  it('reports unknown identity when Meta omits a name or Page ownership is ambiguous', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          { id: 't_1', participants: { data: [{ id: '123' }, { id: 'psid_1' }] } },
          {
            id: 't_2',
            participants: { data: [{ id: 'other-page' }, { id: 'psid_2', name: 'Other Person' }] },
          },
        ],
      }),
    );
    const result = await clientWith(request).listPageConversations({
      pageId: '123',
      accessToken: 'token',
    });
    expect(result.conversations).toEqual([
      { id: 't_1', updatedAt: null, displayName: null },
      { id: 't_2', updatedAt: null, displayName: null },
    ]);
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

  it('fails safely for oversized single messages or aggregate pages', async () => {
    const message = (text: string, index: number) => ({
      id: `mid_${String(index)}`,
      message: text,
      created_time: '2026-10-25T02:01:00+0000',
    });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [message('x'.repeat(16 * 1024 + 1), 1)] }))
      .mockResolvedValueOnce(
        Response.json({
          data: Array.from({ length: 100 }, (_, index) => message('x'.repeat(700), index)),
        }),
      );
    const client = clientWith(request);
    await expect(
      client.listConversationMessages({ conversationId: 't_123', accessToken: 'token' }),
    ).rejects.toMatchObject({ evidence: { status: 502 } });
    await expect(
      client.listConversationMessages({ conversationId: 't_123', accessToken: 'token' }),
    ).rejects.toMatchObject({ evidence: { status: 502 } });
  });

  it('keeps a representative nonempty message page below the response budget', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: Array.from({ length: 25 }, (_, index) => ({
          id: `mid_${String(index)}`,
          message: 'A'.repeat(500),
          created_time: '2026-10-25T02:01:00+0000',
          from: { id: 'psid_789', email: 'private@example.test' },
        })),
      }),
    );
    const result = await clientWith(request).listConversationMessages({
      conversationId: 't_123',
      accessToken: 'token',
    });
    expect(result.messages).toHaveLength(25);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024);
    expect(JSON.stringify(result)).not.toContain('private@example.test');
  });

  it('does not advertise a terminal cursor for conversations or messages', async () => {
    const terminalPage = () =>
      Response.json({ data: [], paging: { cursors: { after: 'terminal-cursor' } } });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(terminalPage())
      .mockResolvedValueOnce(terminalPage());
    const client = clientWith(request);
    expect(
      (await client.listPageConversations({ pageId: '123', accessToken: 'token' })).nextCursor,
    ).toBeNull();
    expect(
      (await client.listConversationMessages({ conversationId: 't_123', accessToken: 'token' }))
        .nextCursor,
    ).toBeNull();
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
