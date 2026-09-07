import { describe, expect, it, vi } from 'vitest';

import { YouTubeHttpClient } from '../src/modules/providers/youtube-http-client.js';

describe('YouTubeHttpClient', () => {
  it('builds an offline PKCE authorization URL with exact state correlation', () => {
    const client = new YouTubeHttpClient({ clientId: 'client-id', clientSecret: 'secret' });
    const url = new URL(
      client.authorizationUrl({
        redirectUri: 'https://relay.test/api/oauth/youtube/callback',
        state: 'state-token',
        codeChallenge: 'challenge',
      }),
    );
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('state')).toBe('state-token');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toContain('youtube.upload');
  });

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

  it('starts and resumes an upload from the provider-confirmed offset', async () => {
    const sessionUrl =
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session';
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { location: sessionUrl } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { range: 'bytes=0-255' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'video-1' }), { status: 200 }));
    const client = new YouTubeHttpClient({
      clientId: 'id',
      clientSecret: 'secret',
      fetch: request,
    });
    await expect(
      client.initiateUpload({
        accessToken: 'access',
        totalBytes: 512,
        mimeType: 'video/mp4',
        metadata: { snippet: { title: 'Clip' } },
        notifySubscribers: false,
      }),
    ).resolves.toBe(sessionUrl);
    await expect(client.queryUpload(sessionUrl, 'access', 512)).resolves.toEqual({
      status: 'incomplete',
      nextOffset: 256,
    });
    await expect(
      client.uploadChunk({
        sessionUrl,
        accessToken: 'access',
        bytes: new Uint8Array(256),
        startOffset: 256,
        totalBytes: 512,
      }),
    ).resolves.toEqual({ status: 'complete', videoId: 'video-1' });
  });

  it.each([
    'https://attacker.example/upload/youtube/v3/videos?upload_id=session',
    'http://www.googleapis.com/upload/youtube/v3/videos?upload_id=session',
    'https://www.googleapis.com.attacker.example/upload/youtube/v3/videos?upload_id=session',
    'https://user@www.googleapis.com/upload/youtube/v3/videos?upload_id=session',
    'not a url',
  ])('rejects an untrusted upload session URL before sending credentials: %s', async (sessionUrl) => {
    const request = vi.fn<typeof fetch>();
    const client = new YouTubeHttpClient({
      clientId: 'id',
      clientSecret: 'secret',
      fetch: request,
    });
    await expect(client.queryUpload(sessionUrl, 'access-secret', 512)).rejects.toThrow(
      /upload session URL/,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects an untrusted upload session URL returned during initiation', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { location: 'https://attacker.example/upload/youtube/v3/videos' },
      }),
    );
    const client = new YouTubeHttpClient({
      clientId: 'id',
      clientSecret: 'secret',
      fetch: request,
    });
    await expect(
      client.initiateUpload({
        accessToken: 'access',
        totalBytes: 512,
        mimeType: 'video/mp4',
        metadata: {},
        notifySubscribers: false,
      }),
    ).rejects.toThrow('not an authorized Google upload URL');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
