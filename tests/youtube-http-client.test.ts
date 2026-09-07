import { describe, expect, it, vi } from 'vitest';

import { YouTubeHttpClient } from '../src/modules/providers/youtube-http-client.js';

describe('YouTubeHttpClient', () => {
  it('exchanges PKCE code material and preserves refresh credentials', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const client = new YouTubeHttpClient({
      clientId: 'id',
      clientSecret: 'secret',
      fetch: request,
      now: () => 0,
    });
    await expect(
      client.exchangeCode({
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: 'https://relay.test/callback',
      }),
    ).resolves.toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: '1970-01-01T01:00:00.000Z',
    });
    const body = request.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get('code_verifier')).toBe('verifier');
  });

  it('discovers exact owned channels', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ items: [{ id: 'channel-1', snippet: { title: 'Studio' } }] }),
          { status: 200 },
        ),
      );
    const client = new YouTubeHttpClient({
      clientId: 'id',
      clientSecret: 'secret',
      fetch: request,
    });
    await expect(client.discoverChannels('access')).resolves.toEqual([
      { id: 'channel-1', displayName: 'Studio' },
    ]);
  });

  it('fails closed on provider errors', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 }));
    const client = new YouTubeHttpClient({
      clientId: 'id',
      clientSecret: 'secret',
      fetch: request,
    });
    await expect(client.discoverChannels('expired')).rejects.toThrow('HTTP 401');
  });
});
