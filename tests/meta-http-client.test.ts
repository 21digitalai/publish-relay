import { describe, expect, it, vi } from 'vitest';

import {
  META_PERMISSIONS,
  MetaHttpClient,
  MetaRequestError,
  parseMetaPermissions,
} from '../src/modules/providers/meta-http-client.js';

function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('MetaHttpClient', () => {
  it('accepts only a complete approved configurable permission set', () => {
    expect(parseMetaPermissions(META_PERMISSIONS.join(','))).toEqual(META_PERMISSIONS);
    expect(() => parseMetaPermissions('pages_show_list')).toThrow('incomplete');
    expect(() => parseMetaPermissions(`${META_PERMISSIONS.join(',')},unknown`)).toThrow();
  });
  it('pins version, callback, state, and the approved Page-linked permission set', () => {
    const client = new MetaHttpClient({ appId: 'app', appSecret: 'secret', graphVersion: 'v23.0' });
    const url = new URL(
      client.authorizationUrl({
        redirectUri: 'https://relay.test/api/oauth/meta/callback',
        state: 's',
      }),
    );
    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.pathname).toBe('/v23.0/dialog/oauth');
    expect(url.searchParams.get('redirect_uri')).toBe('https://relay.test/api/oauth/meta/callback');
    expect(url.searchParams.get('state')).toBe('s');
    expect(url.searchParams.get('scope')?.split(',')).toEqual(META_PERMISSIONS);
    expect(
      () => new MetaHttpClient({ appId: 'a', appSecret: 's', graphVersion: 'latest' }),
    ).toThrow('pinned');
  });

  it('exchanges, lengthens, introspects, and validates all required permissions', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ access_token: 'short', expires_in: 60 }))
      .mockResolvedValueOnce(response({ access_token: 'long', expires_in: 3600 }))
      .mockResolvedValueOnce(
        response({
          data: {
            is_valid: true,
            app_id: 'app',
            user_id: 'meta-user-one',
            expires_at: 2_000_000_000,
            scopes: META_PERMISSIONS,
          },
        }),
      );
    const client = new MetaHttpClient({
      appId: 'app',
      appSecret: 'secret',
      graphVersion: 'v23.0',
      fetch: request,
      now: () => 1_000,
    });
    await expect(
      client.exchangeCode({
        code: 'code',
        redirectUri: 'https://relay.test/api/oauth/meta/callback',
      }),
    ).resolves.toMatchObject({
      accessToken: 'long',
      userId: 'meta-user-one',
      scopes: META_PERMISSIONS,
    });
    expect(request).toHaveBeenCalledTimes(3);
    const firstTarget = request.mock.calls[0]?.[0];
    const firstUrl =
      firstTarget instanceof URL
        ? firstTarget.toString()
        : typeof firstTarget === 'string'
          ? firstTarget
          : '';
    expect(firstUrl).not.toContain('code=code');
  });

  it('fails closed on missing permissions without exposing provider bodies', async () => {
    const client = new MetaHttpClient({
      appId: 'app',
      appSecret: 'secret',
      graphVersion: 'v23.0',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        response({
          data: {
            is_valid: true,
            app_id: 'app',
            user_id: 'meta-user-one',
            scopes: ['pages_show_list'],
          },
        }),
      ),
    });
    const error = await client
      .validateCredential({ access_token: 'token' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MetaRequestError);
    expect((error as MetaRequestError).kind).toBe('permission');
    expect(String(error)).not.toContain('token');
  });

  it('discovers paginated Pages and linked Instagram accounts from allowlisted fields', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          data: [
            {
              id: 'page-1',
              name: 'Page One',
              access_token: 'page-token-1',
              tasks: ['CREATE_CONTENT'],
              instagram_business_account: {
                id: 'ig-1',
                username: 'mira',
                private: 'drop',
              },
            },
          ],
          paging: { cursors: { after: 'next' } },
        }),
      )
      .mockResolvedValueOnce(
        response({
          data: [{ id: 'page-2', name: 'Page Two', access_token: 'page-token-2', tasks: [] }],
        }),
      );
    const client = new MetaHttpClient({
      appId: 'app',
      appSecret: 'secret',
      graphVersion: 'v23.0',
      fetch: request,
    });
    await expect(client.discoverPages('authority')).resolves.toEqual([
      {
        id: 'page-1',
        name: 'Page One',
        accessToken: 'page-token-1',
        tasks: ['CREATE_CONTENT'],
        instagram: { id: 'ig-1', name: 'mira', username: 'mira' },
      },
      { id: 'page-2', name: 'Page Two', accessToken: 'page-token-2', tasks: [] },
    ]);
    const secondTarget = request.mock.calls[1]?.[0];
    const secondUrl =
      secondTarget instanceof URL
        ? secondTarget.toString()
        : typeof secondTarget === 'string'
          ? secondTarget
          : '';
    expect(secondUrl).toContain('after=next');
  });

  it('accepts an explicit zero-Page discovery response', async () => {
    const client = new MetaHttpClient({
      appId: 'app',
      appSecret: 'secret',
      graphVersion: 'v23.0',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response({ data: [] })),
    });

    await expect(client.discoverPages('authority')).resolves.toEqual([]);
  });

  it.each([401, 403])('classifies an already-invalid revoke response (%s)', async (status) => {
    const client = new MetaHttpClient({
      appId: 'app',
      appSecret: 'secret',
      graphVersion: 'v23.0',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response({ error: 'invalid' }, status)),
    });

    await expect(client.revoke('expired-token')).rejects.toMatchObject({
      kind: status === 401 ? 'auth' : 'permission',
    });
  });

  it('classifies rate limits with bounded retry evidence and redacts provider errors', async () => {
    const client = new MetaHttpClient({
      appId: 'app',
      appSecret: 'secret',
      graphVersion: 'v23.0',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response({ error: { message: 'secret body' } }, 429, { 'retry-after': '99' }),
        ),
    });
    const error = await client.discoverPages('token').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'rate_limit', retryAfterSeconds: 99 });
    expect(String(error)).not.toContain('secret body');
    expect(String(error)).not.toContain('token');
  });
});
