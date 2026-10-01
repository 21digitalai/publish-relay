import { describe, expect, it, vi } from 'vitest';

import {
  TikTokHttpClient,
  TikTokRequestError,
} from '../src/modules/providers/tiktok-http-client.js';

const token = {
  access_token: 'access-secret',
  refresh_token: 'refresh-secret',
  open_id: 'subject-1',
  scope: 'video.publish',
  token_type: 'Bearer',
  expires_in: 86_400,
  refresh_expires_in: 100_000,
};
const ok = (data: unknown) => ({ data, error: { code: 'ok', message: '', log_id: 'safe-log' } });
const response = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, ...(headers ? { headers } : {}) });
const client = (request: typeof fetch) =>
  new TikTokHttpClient({
    clientKey: 'client-key',
    clientSecret: 'client-secret',
    fetch: request,
    now: () => 0,
  });

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === 'string' || body instanceof URLSearchParams) return body.toString();
  throw new Error('Unexpected fixture request body');
}

describe('TikTokHttpClient transport', () => {
  it('exchanges and rotates token values without requesting a credentialed redirect', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(token))
      .mockResolvedValueOnce(response({ ...token, refresh_token: 'rotated-secret' }));
    const api = client(request);
    await expect(
      api.exchangeCode({ code: 'code-secret', redirectUri: 'https://relay.test/cb' }),
    ).resolves.toEqual(token);
    await expect(api.refresh('refresh-secret')).resolves.toMatchObject({
      refresh_token: 'rotated-secret',
    });
    expect(request.mock.calls[0]?.[0]).toBe('https://open.tiktokapis.com/v2/oauth/token/');
    const exchange = request.mock.calls[0]?.[1];
    const refresh = request.mock.calls[1]?.[1];
    expect(exchange?.redirect).toBe('manual');
    expect(bodyText(exchange?.body)).toContain('grant_type=authorization_code');
    expect(bodyText(refresh?.body)).toContain('refresh_token=refresh-secret');
    expect(refresh?.signal).toBeDefined();
  });

  it('revokes through OAuth form and accepts the documented empty success', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(client(request).revoke('access-secret')).resolves.toBeUndefined();
    expect(bodyText(request.mock.calls[0]?.[1]?.body)).toContain('token=access-secret');
    expect(request.mock.calls[0]?.[0]).toBe('https://open.tiktokapis.com/v2/oauth/revoke/');
  });

  it('validates creator capability, init, status and cancellation fixtures', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(
          ok({
            creator_username: 'creator',
            creator_nickname: 'Creator',
            creator_avatar_url: 'https://example.test/avatar',
            privacy_level_options: ['SELF_ONLY'],
            comment_disabled: false,
            duet_disabled: true,
            stitch_disabled: true,
            max_video_post_duration_sec: 180,
          }),
        ),
      )
      .mockResolvedValueOnce(response(ok({ publish_id: 'publish-1' })))
      .mockResolvedValueOnce(
        response(ok({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [] })),
      )
      .mockResolvedValueOnce(response(ok(undefined)));
    const api = client(request);
    await expect(api.creatorInfo('access-secret')).resolves.toMatchObject({
      creator_username: 'creator',
    });
    await expect(
      api.initDirectPost('access-secret', {
        title: 'caption',
        privacyLevel: 'SELF_ONLY',
        disableComment: false,
        disableDuet: true,
        disableStitch: true,
        brandContent: false,
        brandOrganic: false,
        isAiGenerated: false,
        videoUrl: 'https://media.test/video',
      }),
    ).resolves.toEqual({ publishId: 'publish-1' });
    await expect(api.status('access-secret', 'publish-1')).resolves.toMatchObject({
      status: 'PUBLISH_COMPLETE',
    });
    await expect(api.cancel('access-secret', 'publish-1')).resolves.toBeUndefined();
    const init = JSON.parse(bodyText(request.mock.calls[1]?.[1]?.body)) as Record<
      string,
      Record<string, unknown>
    >;
    expect(init.source_info).toEqual({
      source: 'PULL_FROM_URL',
      video_url: 'https://media.test/video',
    });
    expect(init.post_info?.is_aigc).toBe(false);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
      'https://open.tiktokapis.com/v2/post/publish/cancel/',
    ]);
  });

  it('rejects malformed envelopes, partial data and unsafe pull URLs', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: {}, error: { code: 'ok' } }))
      .mockResolvedValueOnce(response({ data: { publish_id: '' }, error: { code: 'ok' } }));
    const api = client(request);
    await expect(api.creatorInfo('token')).rejects.toBeInstanceOf(TikTokRequestError);
    await expect(
      api.initDirectPost('token', {
        title: '',
        privacyLevel: 'SELF_ONLY',
        disableComment: true,
        disableDuet: true,
        disableStitch: true,
        brandContent: false,
        brandOrganic: false,
        isAiGenerated: false,
        videoUrl: 'https://media.test/video',
      }),
    ).rejects.toBeInstanceOf(TikTokRequestError);
    await expect(
      api.initDirectPost('token', {
        title: '',
        privacyLevel: 'SELF_ONLY',
        disableComment: true,
        disableDuet: true,
        disableStitch: true,
        brandContent: false,
        brandOrganic: false,
        isAiGenerated: false,
        videoUrl: 'http://media.test/video',
      }),
    ).rejects.toThrow('HTTPS');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('classifies provider errors, rate limit and redirects without leaking body or secrets', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(
          { error: { code: 'rate_limit_exceeded', message: 'secret-caption', log_id: 'safe-log' } },
          429,
          { 'retry-after': '30' },
        ),
      )
      .mockResolvedValueOnce(
        response(
          { error: 'invalid_grant', error_description: 'secret-token', log_id: 'safe-log' },
          400,
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }),
      );
    const api = client(request);
    const rate = await api.status('secret-token', 'publish-1').catch((error: unknown) => error);
    expect(rate).toMatchObject({
      kind: 'rate_limit',
      retryAfterSeconds: 30,
      code: 'rate_limit_exceeded',
    });
    expect(String(rate)).not.toContain('secret');
    const auth = await api.refresh('refresh-secret').catch((error: unknown) => error);
    expect(auth).toMatchObject({ status: 400, code: 'invalid_grant' });
    expect(String(auth)).not.toContain('secret');
    await expect(api.cancel('secret-token', 'publish-1')).rejects.toMatchObject({ status: 302 });
  });

  it('treats init network loss and empty success as unknown, without automatic retry', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('secret-token'))
      .mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const api = client(request);
    const input = {
      title: 'secret-caption',
      privacyLevel: 'SELF_ONLY' as const,
      disableComment: true,
      disableDuet: true,
      disableStitch: true,
      brandContent: false,
      brandOrganic: false,
      isAiGenerated: false,
      videoUrl: 'https://media.test/video',
    };
    await expect(api.initDirectPost('secret-token', input)).rejects.toMatchObject({
      outcomeUnknown: true,
    });
    await expect(api.initDirectPost('secret-token', input)).rejects.toMatchObject({
      outcomeUnknown: true,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects partial rotated tokens and classifies auth and transient responses', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ ...token, refresh_token: undefined }))
      .mockResolvedValueOnce(
        response({ error: { code: 'access_token_invalid', log_id: 'auth-log' } }, 401),
      )
      .mockResolvedValueOnce(
        response({ error: { code: 'internal_error', log_id: 'server-log' } }, 503),
      );
    const api = client(request);
    await expect(api.refresh('old-token')).rejects.toBeInstanceOf(TikTokRequestError);
    await expect(api.creatorInfo('bad-token')).rejects.toMatchObject({
      kind: 'auth',
      code: 'access_token_invalid',
    });
    await expect(api.status('token', 'publish-1')).rejects.toMatchObject({
      kind: 'transient',
      status: 503,
    });
    expect(request).toHaveBeenCalledTimes(3);
  });
});
