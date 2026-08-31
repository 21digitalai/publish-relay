import { describe, expect, it, vi } from 'vitest';

import { XHttpClient } from '../src/modules/providers/x-http-client.js';

const credential = JSON.stringify({ accessToken: 'token', accessTokenSecret: 'token-secret' });

function response(body: object, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, ...(headers ? { headers } : {}) });
}

describe('X OAuth 1.0a HTTP client', () => {
  it('signs identity discovery without exposing secrets in the URL or body', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ data: { id: '1', name: 'Daily', username: 'TheDailyViber' } }));
    const client = new XHttpClient({
      consumerKey: 'consumer',
      consumerSecret: 'consumer-secret',
      fetch: request,
      nonce: () => 'nonce',
      now: () => 1_700_000_000_000,
    });
    await expect(client.currentAccount(credential)).resolves.toMatchObject({
      username: 'TheDailyViber',
    });
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe('https://api.x.com/2/users/me');
    expect(init?.body).toBeUndefined();
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toContain('OAuth ');
    expect(JSON.stringify([url, init])).not.toContain('token-secret');
    expect(JSON.stringify([url, init])).not.toContain('consumer-secret');
  });

  it('maps native text, media, and quote payloads exactly', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'post-1' } }))
      .mockResolvedValueOnce(response({ data: { id: '1', name: 'Daily', username: 'daily' } }));
    const client = new XHttpClient({
      consumerKey: 'consumer',
      consumerSecret: 'secret',
      fetch: request,
    }).bindCredential(credential);
    await expect(
      client.createPost({
        text: 'Exact text',
        mediaIds: ['media-1'],
        quoteTweetId: 'quote-1',
        idempotencyKey: 'caller-owned-key',
      }),
    ).resolves.toEqual({ id: 'post-1', username: 'daily' });
    const requestBody = request.mock.calls[0]?.[1]?.body;
    expect(typeof requestBody).toBe('string');
    expect(JSON.parse(requestBody as string)).toEqual({
      text: 'Exact text',
      media: { media_ids: ['media-1'] },
      quote_tweet_id: 'quote-1',
    });
  });

  it('returns null for lookup 404 and preserves retry headers', async () => {
    const notFound = vi.fn<typeof fetch>().mockResolvedValue(response({}, 404));
    const client = new XHttpClient({
      consumerKey: 'consumer',
      consumerSecret: 'secret',
      fetch: notFound,
    }).bindCredential(credential);
    await expect(client.getPost('missing')).resolves.toBeNull();

    const limited = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ title: 'Too Many Requests' }, 429, { 'retry-after': '30' }));
    const limitedClient = new XHttpClient({
      consumerKey: 'consumer',
      consumerSecret: 'secret',
      fetch: limited,
    });
    await expect(limitedClient.currentAccount(credential)).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 30,
    });
  });

  it('fails closed for unverified connection and revocation lifecycle operations', async () => {
    const client = new XHttpClient({ consumerKey: 'consumer', consumerSecret: 'secret' });
    await expect(client.connect()).rejects.toThrow('request-token callback lifecycle');
    await expect(client.revoke(credential)).rejects.toThrow('revocation endpoint is not verified');
  });

  it('exchanges OAuth 1.0a request and access tokens without putting secrets in URLs', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          'oauth_token=request-token&oauth_token_secret=request-secret&oauth_callback_confirmed=true',
        ),
      )
      .mockResolvedValueOnce(
        new Response('oauth_token=access-token&oauth_token_secret=access-secret'),
      );
    const client = new XHttpClient({
      consumerKey: 'consumer',
      consumerSecret: 'secret',
      fetch: request,
      nonce: () => 'nonce',
      now: () => 1_700_000_000_000,
    });
    const started = await client.beginConnection('https://relay.example.test/oauth/x/callback');
    expect(started).toEqual({
      requestToken: 'request-token',
      requestTokenSecret: 'request-secret',
      authorizationUrl: 'https://api.x.com/oauth/authorize?oauth_token=request-token',
    });
    await expect(
      client.completeConnection(started.requestToken, started.requestTokenSecret, 'verifier'),
    ).resolves.toEqual({
      credential: JSON.stringify({
        accessToken: 'access-token',
        accessTokenSecret: 'access-secret',
      }),
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://api.x.com/oauth/request_token',
      'https://api.x.com/oauth/access_token',
    ]);
    expect(JSON.stringify(request.mock.calls)).not.toContain('request-secret');
    expect(JSON.stringify(request.mock.calls)).not.toContain('access-secret');
  });
});
