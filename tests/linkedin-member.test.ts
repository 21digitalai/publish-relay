import { describe, expect, it, vi } from 'vitest';

import {
  parseLinkedInContent,
  parseLinkedInImageContent,
  parseLinkedInVideoContent,
  validateLinkedInImageAsset,
  validateLinkedInTextContent,
  validateLinkedInVideoAsset,
} from '../src/modules/providers/linkedin-content.js';
import {
  classifyLinkedInDispatchFailure,
  classifyLinkedInPrePostFailure,
} from '../src/modules/providers/linkedin-dispatch.service.js';
import {
  LinkedInHttpClient,
  LinkedInRequestError,
  LinkedInVideoReadinessError,
} from '../src/modules/providers/linkedin-http-client.js';

const options = { clientId: 'client-id', clientSecret: 'client-secret', now: () => 1_000 };

describe('LinkedIn member integration', () => {
  it('admits one bounded JPEG or PNG image with text', () => {
    const mediaId = '00000000-0000-4000-8000-000000000123';
    expect(
      parseLinkedInImageContent({ kind: 'single_image', text: ' Picture ' }, [mediaId]),
    ).toEqual({ kind: 'single_image', text: 'Picture', mediaId });
    for (const ids of [[], [mediaId, mediaId]])
      expect(() =>
        parseLinkedInImageContent({ kind: 'single_image', text: 'Picture' }, ids),
      ).toThrow();
    expect(() => {
      validateLinkedInImageAsset({ mimeType: 'image/png', byteSize: 5_000_000 });
    }).not.toThrow();
    for (const media of [
      { mimeType: 'image/gif', byteSize: 100 },
      { mimeType: 'image/jpeg', byteSize: 0 },
      { mimeType: 'image/png', byteSize: 5_000_001 },
    ])
      expect(() => {
        validateLinkedInImageAsset(media);
      }).toThrow();
  });

  it('uses Images API upload, unversioned legacy readiness, and a member image post', async () => {
    const credential = {
      accessToken: 'access',
      expiresAt: new Date(3_601_000).toISOString(),
      memberUrn: 'urn:li:person:member-1',
      scope: 'w_member_social',
    };
    const image = 'urn:li:image:image-1';
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: {
              image,
              uploadUrl: 'https://www.linkedin.com/upload/image',
              uploadUrlExpiresAt: 10_000,
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: image, owner: credential.memberUrn, status: 'AVAILABLE' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:42' } }),
      );
    const client = new LinkedInHttpClient({ ...options, fetch: request });
    await expect(
      client.uploadImage({ credential, bytes: Buffer.alloc(100), mimeType: 'image/png' }),
    ).resolves.toBe(image);
    expect(request.mock.calls[0]?.[0]).toBe(
      'https://api.linkedin.com/rest/images?action=initializeUpload',
    );
    expect(request.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT', redirect: 'error' });
    await expect(client.getImageStatus({ credential, image })).resolves.toBe('AVAILABLE');
    expect(request.mock.calls[2]?.[1]?.headers).not.toHaveProperty('Linkedin-Version');
    await expect(client.publishImage({ credential, text: 'Picture', image })).resolves.toBe(
      'urn:li:share:42',
    );
    expect(JSON.parse(request.mock.calls[3]?.[1]?.body as string)).toMatchObject({
      author: credential.memberUrn,
      content: { media: { id: image } },
    });
  });

  it('fails closed when legacy image readiness is denied or mismatched', async () => {
    const credential = {
      accessToken: 'access',
      expiresAt: new Date(3_601_000).toISOString(),
      memberUrn: 'urn:li:person:member-1',
      scope: 'w_member_social',
    };
    const image = 'urn:li:image:image-1';
    const denied = new LinkedInHttpClient({
      ...options,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 })),
    });
    await expect(denied.getImageStatus({ credential, image })).rejects.toMatchObject({
      kind: 'auth',
    });
    const mismatch = new LinkedInHttpClient({
      ...options,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ id: image, owner: 'urn:li:person:other', status: 'AVAILABLE' }),
            { status: 200 },
          ),
        ),
    });
    await expect(mismatch.getImageStatus({ credential, image })).rejects.toThrow('mismatch');
  });

  it('does not create a post after an interrupted image upload and holds a missing post receipt', async () => {
    const credential = {
      accessToken: 'access',
      expiresAt: new Date(3_601_000).toISOString(),
      memberUrn: 'urn:li:person:member-1',
      scope: 'w_member_social',
    };
    const image = 'urn:li:image:image-1';
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: {
              image,
              uploadUrl: 'https://www.linkedin.com/upload/image',
              uploadUrlExpiresAt: 10_000,
            },
          }),
          { status: 200 },
        ),
      )
      .mockRejectedValueOnce(new TypeError('upload interrupted'));
    const client = new LinkedInHttpClient({ ...options, fetch: request });
    await expect(
      client.uploadImage({ credential, bytes: Buffer.alloc(100), mimeType: 'image/jpeg' }),
    ).rejects.toThrow('upload interrupted');
    expect(request).toHaveBeenCalledTimes(2);
    request.mockResolvedValueOnce(new Response(null, { status: 201 }));
    await expect(client.publishImage({ credential, text: 'Picture', image })).rejects.toMatchObject(
      { outcomeUnknown: true },
    );
  });
  it('requires exactly one prepared media ID for explicit video content', () => {
    const mediaId = '00000000-0000-4000-8000-000000000123';
    const content = { kind: 'video', text: 'Watch', title: 'Demo' };
    expect(parseLinkedInVideoContent(content, [mediaId])).toEqual({ ...content, mediaId });
    for (const ids of [[], [mediaId, mediaId]])
      expect(() => parseLinkedInVideoContent(content, ids)).toThrow();
    expect(() => parseLinkedInVideoContent({ ...content, title: '' }, [mediaId])).toThrow();
    expect(() => parseLinkedInContent(content, [mediaId])).toThrow();
  });
  it('applies conservative LinkedIn MP4 size, duration and codec bounds', () => {
    const media = {
      mimeType: 'video/mp4',
      byteSize: 75_000,
      durationMs: 3_000,
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
    };
    expect(() => {
      validateLinkedInVideoAsset(media);
    }).not.toThrow();
    for (const changed of [
      { mimeType: 'video/quicktime' },
      { byteSize: 74_999 },
      { byteSize: 500_000_001 },
      { durationMs: 2_999 },
      { durationMs: 1_800_001 },
      { videoCodec: 'hevc' },
      { audioCodec: 'opus' },
    ])
      expect(() => {
        validateLinkedInVideoAsset({ ...media, ...changed });
      }).toThrow();
  });
  it('uploads ordered video parts, finalizes ETags, and requires matching ready asset', async () => {
    const credential = {
      accessToken: 'access',
      expiresAt: new Date(3_601_000).toISOString(),
      memberUrn: 'urn:li:person:member-1',
      scope: 'w_member_social',
    };
    const bytes = Buffer.alloc(75_000);
    const video = 'urn:li:video:video-1';
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: {
              video,
              uploadToken: 'token',
              uploadUrlsExpireAt: 10_000,
              uploadInstructions: [
                {
                  firstByte: 0,
                  lastByte: 39_999,
                  uploadUrl: 'https://www.linkedin.com/upload/one',
                },
                {
                  firstByte: 40_000,
                  lastByte: 74_999,
                  uploadUrl: 'https://www.linkedin.com/upload/two',
                },
              ],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { etag: 'part-1' } }))
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { etag: 'part-2' } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: video,
            owner: credential.memberUrn,
            status: 'AVAILABLE',
          }),
          { status: 200 },
        ),
      );
    const client = new LinkedInHttpClient({ ...options, fetch: request });
    await expect(client.uploadVideo({ credential, bytes })).resolves.toBe(video);
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body as string)).toEqual({
      initializeUploadRequest: {
        owner: credential.memberUrn,
        fileSizeBytes: 75_000,
        uploadCaptions: false,
        uploadThumbnail: false,
      },
    });
    expect(request.mock.calls[1]?.[1]?.body).toHaveLength(40_000);
    expect(request.mock.calls[2]?.[1]?.body).toHaveLength(35_000);
    expect(JSON.parse(request.mock.calls[3]?.[1]?.body as string)).toEqual({
      finalizeUploadRequest: { video, uploadToken: 'token', uploadedPartIds: ['part-1', 'part-2'] },
    });
    await expect(client.getVideoStatus({ credential, video })).resolves.toBe('AVAILABLE');
    expect(request.mock.calls[4]?.[0]).toBe(
      'https://api.linkedin.com/rest/videos/urn%3Ali%3Avideo%3Avideo-1',
    );
  });

  it('rejects malformed video ranges and untrusted signed upload URLs before PUT', async () => {
    const credential = {
      accessToken: 'access',
      expiresAt: new Date(3_601_000).toISOString(),
      memberUrn: 'urn:li:person:member-1',
      scope: 'w_member_social',
    };
    for (const uploadInstructions of [
      [{ firstByte: 1, lastByte: 74_999, uploadUrl: 'https://www.linkedin.com/upload' }],
      [{ firstByte: 0, lastByte: 74_999, uploadUrl: 'https://attacker.example/upload' }],
    ]) {
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            value: {
              video: 'urn:li:video:video-1',
              uploadToken: '',
              uploadUrlsExpireAt: 10_000,
              uploadInstructions,
            },
          }),
          { status: 200 },
        ),
      );
      const client = new LinkedInHttpClient({ ...options, fetch: request });
      await expect(
        client.uploadVideo({ credential, bytes: Buffer.alloc(75_000) }),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it('does not finalize a partial upload without an ETag receipt', async () => {
    const credential = {
      accessToken: 'access',
      expiresAt: new Date(3_601_000).toISOString(),
      memberUrn: 'urn:li:person:member-1',
      scope: 'w_member_social',
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: {
              video: 'urn:li:video:video-1',
              uploadToken: '',
              uploadUrlsExpireAt: 10_000,
              uploadInstructions: [
                { firstByte: 0, lastByte: 74_999, uploadUrl: 'https://www.linkedin.com/upload' },
              ],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = new LinkedInHttpClient({ ...options, fetch: request });
    await expect(client.uploadVideo({ credential, bytes: Buffer.alloc(75_000) })).rejects.toThrow(
      'part receipt is missing',
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('returns processing status without treating an unfinished video as ready', async () => {
    const credential = {
      accessToken: 'access',
      expiresAt: new Date(3_601_000).toISOString(),
      memberUrn: 'urn:li:person:member-1',
      scope: 'w_member_social',
    };
    const video = 'urn:li:video:video-1';
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: video,
          owner: credential.memberUrn,
          status: 'PROCESSING',
        }),
        { status: 200 },
      ),
    );
    const client = new LinkedInHttpClient({ ...options, fetch: request });
    await expect(client.getVideoStatus({ credential, video })).resolves.toBe('PROCESSING');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('only posts a member-owned AVAILABLE video with the exact media payload', async () => {
    const credential = {
      accessToken: 'access',
      expiresAt: new Date(3_601_000).toISOString(),
      memberUrn: 'urn:li:person:member-1',
      scope: 'w_member_social',
    };
    const video = 'urn:li:video:video-1';
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: video,
            owner: credential.memberUrn,
            status: 'AVAILABLE',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:post-1' } }),
      );
    const client = new LinkedInHttpClient({ ...options, fetch: request });
    await expect(
      client.publishVideo({ credential, text: 'Watch this', video, title: 'Demo' }),
    ).resolves.toBe('urn:li:share:post-1');
    const postBody = JSON.parse(request.mock.calls[1]?.[1]?.body as string) as {
      content: unknown;
    };
    expect(postBody.content).toEqual({
      media: { id: video, title: 'Demo' },
    });
  });

  it('does not post a PROCESSING or foreign-owned video', async () => {
    const credential = {
      accessToken: 'access',
      expiresAt: new Date(3_601_000).toISOString(),
      memberUrn: 'urn:li:person:member-1',
      scope: 'w_member_social',
    };
    const video = 'urn:li:video:video-1';
    for (const response of [
      { id: video, owner: credential.memberUrn, status: 'PROCESSING' },
      { id: video, owner: 'urn:li:person:other', status: 'AVAILABLE' },
    ]) {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
      const client = new LinkedInHttpClient({ ...options, fetch: request });
      await expect(
        client.publishVideo({ credential, text: 'Watch', video, title: 'Demo' }),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    }
  });
  it('classifies a video status failure as definitely pre-POST', async () => {
    const credential = {
      accessToken: 'access',
      expiresAt: new Date(3_601_000).toISOString(),
      memberUrn: 'urn:li:person:member-1',
      scope: 'w_member_social',
    };
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    const client = new LinkedInHttpClient({ ...options, fetch: request });
    await expect(
      client.publishVideo({
        credential,
        text: 'Watch',
        video: 'urn:li:video:asset',
        title: 'Demo',
      }),
    ).rejects.toBeInstanceOf(LinkedInVideoReadinessError);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('retries definite rate-limit rejection but holds ambiguous delivery outcomes', () => {
    const now = new Date('2026-09-28T07:00:00Z');
    const rejected = new LinkedInRequestError(429, 'rate_limit', 'Rate limited');
    expect(classifyLinkedInDispatchFailure(rejected, 1, now, () => 0.5)).toEqual({
      outcome: 'rate_limit',
      retryAt: new Date(now.getTime() + 15_000),
    });
    expect(classifyLinkedInDispatchFailure(rejected, 5, now, () => 0.5)).toEqual({
      outcome: 'rate_limit',
    });
    expect(
      classifyLinkedInDispatchFailure(
        new LinkedInRequestError(503, 'transient', 'Server error'),
        1,
        now,
      ),
    ).toEqual({ outcome: 'unknown' });
    expect(
      classifyLinkedInDispatchFailure(
        new LinkedInRequestError(0, 'permanent', 'Missing receipt', true),
        1,
        now,
      ),
    ).toEqual({ outcome: 'unknown' });
    expect(classifyLinkedInDispatchFailure(new Error('Network disconnected'), 1, now)).toEqual({
      outcome: 'unknown',
    });
    expect(
      classifyLinkedInDispatchFailure(
        new LinkedInVideoReadinessError('Still processing'),
        1,
        now,
        () => 0.5,
      ),
    ).toEqual({ outcome: 'transient', retryAt: new Date(now.getTime() + 15_000) });
    expect(
      classifyLinkedInDispatchFailure(
        new LinkedInVideoReadinessError('Processing failed', true),
        1,
        now,
      ),
    ).toEqual({ outcome: 'validation' });
  });

  it('bounds definitely pre-POST transport and provider retries', () => {
    const now = new Date('2026-10-21T00:00:00Z');
    expect(
      classifyLinkedInPrePostFailure(new TypeError('fetch failed'), 1, now, () => 0.5),
    ).toEqual({
      outcome: 'transient',
      retryAt: new Date(now.getTime() + 15_000),
    });
    expect(classifyLinkedInPrePostFailure(new TypeError('fetch failed'), 5, now)).toEqual({
      outcome: 'transient',
    });
    expect(
      classifyLinkedInPrePostFailure(
        new LinkedInRequestError(503, 'transient', 'Unavailable'),
        1,
        now,
        () => 0.5,
      ),
    ).toEqual({ outcome: 'transient', retryAt: new Date(now.getTime() + 15_000) });
    expect(classifyLinkedInPrePostFailure(new Error('Invalid media'), 1, now)).toEqual({
      outcome: 'validation',
    });
  });

  it('requests member-posting scope and binds the exact callback and state', () => {
    const client = new LinkedInHttpClient(options);
    const url = new URL(
      client.authorizationUrl({
        redirectUri: 'https://relay.example/api/oauth/linkedin/callback',
        state: 'nonce',
      }),
    );
    expect(url.origin).toBe('https://www.linkedin.com');
    expect(url.searchParams.get('scope')?.split(' ')).toContain('w_member_social');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://relay.example/api/oauth/linkedin/callback',
    );
    expect(url.searchParams.get('state')).toBe('nonce');
  });

  it('exchanges a code and identifies only the authenticated member', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'access',
          expires_in: 3600,
          scope: 'openid profile email w_member_social',
        }),
      )
      .mockResolvedValueOnce(Response.json({ sub: 'member-1', name: 'Member One' }));
    const client = new LinkedInHttpClient({ ...options, fetch: request });
    const credential = await client.exchangeCode({
      code: 'code',
      redirectUri: 'https://relay.example/callback',
    });
    expect(credential).toEqual({
      accessToken: 'access',
      expiresAt: new Date(3_601_000).toISOString(),
      memberUrn: 'urn:li:person:member-1',
      scope: 'openid profile email w_member_social',
    });
    expect((request.mock.calls[0]?.[1]?.body as URLSearchParams).toString()).toContain(
      'redirect_uri=https%3A%2F%2Frelay.example%2Fcallback',
    );
    expect(request.mock.calls[1]?.[0]).toBe('https://api.linkedin.com/v2/userinfo');
  });

  it('refuses an explicitly missing posting grant before member discovery', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ access_token: 'access', expires_in: 3600, scope: 'openid profile' }),
      );
    await expect(
      new LinkedInHttpClient({ ...options, fetch: request }).exchangeCode({
        code: 'code',
        redirectUri: 'https://relay.example/callback',
      }),
    ).rejects.toThrow('member posting scope');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses the member URN for REST posting and requires a receipt', async () => {
    const credential = {
      accessToken: 'access',
      expiresAt: new Date(3_601_000).toISOString(),
      memberUrn: 'urn:li:person:member-1',
      scope: 'w_member_social',
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:42' } }),
      );
    const client = new LinkedInHttpClient({ ...options, fetch: request });
    expect(await client.publishText({ credential, text: 'Hello members' })).toBe('urn:li:share:42');
    expect(request.mock.calls[0]?.[0]).toBe('https://api.linkedin.com/rest/posts');
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      author: credential.memberUrn,
      commentary: 'Hello members',
      lifecycleState: 'PUBLISHED',
    });
    request.mockResolvedValueOnce(new Response(null, { status: 201 }));
    await expect(client.publishText({ credential, text: 'Hello members' })).rejects.toMatchObject({
      outcomeUnknown: true,
    });
  });

  it('posts an explicit HTTPS article without scraping or implicit thumbnail', async () => {
    const credential = {
      accessToken: 'access',
      expiresAt: new Date(3_601_000).toISOString(),
      memberUrn: 'urn:li:person:member-1',
      scope: 'w_member_social',
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:article-1' } }),
      );
    const client = new LinkedInHttpClient({ ...options, fetch: request });
    await expect(
      client.publishArticle({
        credential,
        text: 'Read this',
        linkUrl: 'https://example.com/article',
        title: 'Article title',
        description: 'Article summary',
      }),
    ).resolves.toBe('urn:li:share:article-1');
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      author: credential.memberUrn,
      commentary: 'Read this',
      content: {
        article: {
          source: 'https://example.com/article',
          title: 'Article title',
          description: 'Article summary',
        },
      },
    });
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      'Linkedin-Version': '202605',
      'X-Restli-Protocol-Version': '2.0.0',
    });
    expect(request.mock.calls[0]?.[1]?.body).not.toContain('thumbnail');
    request.mockResolvedValueOnce(new Response(null, { status: 201 }));
    await expect(
      client.publishArticle({
        credential,
        text: 'Read this',
        linkUrl: 'https://example.com/article',
        title: 'Title',
      }),
    ).rejects.toMatchObject({ outcomeUnknown: true });
  });

  it('distinguishes an article attachment from ordinary text containing a URL', () => {
    expect(parseLinkedInContent({ type: 'text', text: 'https://example.com' }, [])).toEqual({
      kind: 'text',
      text: 'https://example.com',
    });
    expect(
      parseLinkedInContent(
        {
          kind: 'link',
          text: 'Read this',
          linkUrl: 'https://example.com',
          title: 'Title',
        },
        [],
      ),
    ).toMatchObject({ kind: 'link', linkUrl: 'https://example.com' });
    for (const content of [
      { kind: 'link', text: 'Read', linkUrl: 'http://example.com', title: 'Title' },
      { kind: 'link', text: 'Read', linkUrl: 'https://example.com', title: '' },
    ])
      expect(() => parseLinkedInContent(content, [])).toThrow();
    expect(() =>
      parseLinkedInContent(
        {
          kind: 'link',
          text: 'Read',
          linkUrl: 'https://example.com',
          title: 'Title',
        },
        ['media-id'],
      ),
    ).toThrow();
  });

  it('classifies HTTP rejection and ambiguous provider failure from the actual publish client', async () => {
    const credential = {
      accessToken: 'access',
      expiresAt: new Date(3_601_000).toISOString(),
      memberUrn: 'urn:li:person:member-1',
      scope: 'w_member_social',
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const client = new LinkedInHttpClient({ ...options, fetch: request });
    await expect(client.publishText({ credential, text: 'Hello' })).rejects.toMatchObject({
      kind: 'rate_limit',
      outcomeUnknown: false,
    });
    await expect(client.publishText({ credential, text: 'Hello' })).rejects.toMatchObject({
      kind: 'transient',
    });
  });

  it('rejects unsupported media, empty text and oversized member posts', () => {
    expect(() => {
      validateLinkedInTextContent({ type: 'text', text: '  hello  ' }, []);
    }).not.toThrow();
    expect(() => {
      validateLinkedInTextContent({ type: 'text', text: '' }, []);
    }).toThrow();
    expect(() => {
      validateLinkedInTextContent({ type: 'text', text: 'x'.repeat(3001) }, []);
    }).toThrow();
    expect(() => {
      validateLinkedInTextContent({ type: 'text', text: 'hello' }, ['media-id']);
    }).toThrow();
    expect(LinkedInRequestError).toBeDefined();
  });
});
