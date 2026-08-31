import { readFile } from 'node:fs/promises';
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

  it('treats the sanitized live X body-level not-found response as missing', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/x-lookup-oauth1.json', import.meta.url), 'utf8'),
    ) as {
      authMode: string;
      missing: { status: number; errors: { title: string; type: string; resourceType: string }[] };
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ errors: fixture.missing.errors }, fixture.missing.status));
    const client = new XHttpClient({
      consumerKey: 'consumer',
      consumerSecret: 'secret',
      fetch: request,
    }).bindCredential(credential);

    await expect(client.getPost('2094383220275966285')).resolves.toBeNull();
    expect(fixture.authMode).toBe('OAuth 1.0a User Context');
    expect(fixture.missing.errors[0]).toMatchObject({
      title: 'Not Found Error',
      resourceType: 'tweet',
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

  it('encodes the X INIT, APPEND, FINALIZE, and bounded STATUS lifecycle', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ media_id_string: 'media-1', expires_after_secs: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(response({ processing_info: { state: 'pending' } }))
      .mockResolvedValueOnce(
        response({ processing_info: { state: 'in_progress', check_after_secs: 2 } }),
      )
      .mockResolvedValueOnce(response({ processing_info: { state: 'succeeded' } }));
    const sleep = vi.fn(() => Promise.resolve());
    const client = new XHttpClient({
      consumerKey: 'consumer',
      consumerSecret: 'secret',
      fetch: request,
      sleep,
      maxMediaStatusPolls: 3,
    }).bindCredential(credential);

    await expect(
      client.init({ totalBytes: 3, mimeType: 'image/png', idempotencyKey: 'stage-1' }),
    ).resolves.toEqual({ mediaId: 'media-1', expiresAfterSeconds: 3600 });
    await expect(client.append('media-1', 0, Buffer.from('abc'))).resolves.toBeUndefined();
    await expect(client.finalize('media-1')).resolves.toEqual({ state: 'pending' });
    await expect(client.status('media-1')).resolves.toEqual({ state: 'succeeded' });

    const initBody = request.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(Object.fromEntries(initBody.entries())).toEqual({
      command: 'INIT',
      total_bytes: '3',
      media_type: 'image/png',
      media_category: 'tweet_image',
    });
    const appendBody = request.mock.calls[1]?.[1]?.body as FormData;
    expect(appendBody.get('command')).toBe('APPEND');
    expect(appendBody.get('media_id')).toBe('media-1');
    expect(appendBody.get('segment_index')).toBe('0');
    expect(appendBody.get('media')).toBeInstanceOf(Blob);
    expect(sleep).toHaveBeenCalledWith(2000);
    const requestedUrls = request.mock.calls.map(([url]) => {
      if (typeof url !== 'string') throw new Error('Expected a string request URL');
      return url;
    });
    expect(requestedUrls).toEqual([
      'https://upload.twitter.com/1.1/media/upload.json',
      'https://upload.twitter.com/1.1/media/upload.json',
      'https://upload.twitter.com/1.1/media/upload.json',
      'https://upload.twitter.com/1.1/media/upload.json?command=STATUS&media_id=media-1',
      'https://upload.twitter.com/1.1/media/upload.json?command=STATUS&media_id=media-1',
    ]);
  });

  it('preserves media rate limits and bounds pending STATUS polling', async () => {
    const limited = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ errors: [{ message: 'Upload rate limited' }] }, 429, { 'retry-after': '12' }),
      );
    const limitedClient = new XHttpClient({
      consumerKey: 'consumer',
      consumerSecret: 'secret',
      fetch: limited,
    }).bindCredential(credential);
    await expect(
      limitedClient.init({ totalBytes: 1, mimeType: 'image/gif', idempotencyKey: 'limited' }),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 12 });

    const pending = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(response({ processing_info: { state: 'pending' } })),
      );
    const boundedClient = new XHttpClient({
      consumerKey: 'consumer',
      consumerSecret: 'secret',
      fetch: pending,
      sleep: () => Promise.resolve(),
      maxMediaStatusPolls: 2,
    }).bindCredential(credential);
    await expect(boundedClient.status('media-2')).resolves.toEqual({ state: 'pending' });
    expect(pending).toHaveBeenCalledTimes(2);

    const notFinalizedClient = new XHttpClient({
      consumerKey: 'consumer',
      consumerSecret: 'secret',
      fetch: () => Promise.resolve(response({ media_id_string: 'media-3' })),
    }).bindCredential(credential);
    await expect(notFinalizedClient.status('media-3')).resolves.toEqual({
      state: 'not_finalized',
    });
  });
});
