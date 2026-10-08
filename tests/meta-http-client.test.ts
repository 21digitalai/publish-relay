import { describe, expect, it, vi } from 'vitest';

import {
  META_PERMISSIONS,
  META_FAMILY_PERMISSIONS,
  MetaHttpClient,
  MetaRequestError,
  parseMetaFamilyPermissions,
} from '../src/modules/providers/meta-http-client.js';

function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('MetaHttpClient', () => {
  it('requires explicit exact permissions for each independent grant family', () => {
    for (const family of ['facebook_pages', 'instagram'] as const) {
      const expected = META_FAMILY_PERMISSIONS[family];
      expect(parseMetaFamilyPermissions(family, expected.join(','))).toEqual(expected);
      expect(() => parseMetaFamilyPermissions(family, undefined)).toThrow('explicitly verified');
      expect(() => parseMetaFamilyPermissions(family, META_PERMISSIONS.join(','))).toThrow(
        'family allowlist',
      );
    }
  });

  it('uses only the selected family scopes and discovery fields', async () => {
    for (const family of ['facebook_pages', 'instagram'] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ data: [] }));
      const client = new MetaHttpClient({
        appId: 'app',
        appSecret: 'secret',
        graphVersion: 'v23.0',
        fetch,
      });
      const url = new URL(
        client.authorizationUrl({
          redirectUri: 'https://relay.test/api/oauth/meta/callback',
          state: 'opaque-state',
          permissions: META_FAMILY_PERMISSIONS[family],
        }),
      );
      expect(url.searchParams.get('scope')?.split(',')).toEqual(META_FAMILY_PERMISSIONS[family]);
      await client.discoverPages('authority', family);
      const target = fetch.mock.calls[0]?.[0];
      expect(target).toBeInstanceOf(URL);
      if (!(target instanceof URL)) throw new Error('Expected Graph URL');
      const requestUrl = target;
      expect(requestUrl.searchParams.get('fields')?.includes('instagram_business_account')).toBe(
        family === 'instagram',
      );
    }
  });

  it('uses GET with app bearer auth and keeps debug_token 400 diagnostics allowlisted', async () => {
    const request = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response(
        {
          error: {
            code: 100,
            error_subcode: 33,
            message: 'private graph detail',
            fbtrace_id: 'trace-123',
          },
        },
        400,
      ),
    );
    const client = new MetaHttpClient({
      appId: 'app',
      appSecret: 'secret',
      graphVersion: 'v23.0',
      fetch: request,
    });
    const error = await client
      .validateCredential(
        { access_token: 'private-input-token' },
        META_FAMILY_PERMISSIONS.facebook_pages,
      )
      .catch((caught: unknown) => caught);
    const target = request.mock.calls[0]?.[0];
    expect(target).toBeInstanceOf(URL);
    if (!(target instanceof URL)) throw new Error('Expected Graph URL');
    expect(target.origin + target.pathname).toBe('https://graph.facebook.com/v23.0/debug_token');
    expect(target.searchParams.get('input_token')).toBe('private-input-token');
    expect(target.searchParams.has('access_token')).toBe(false);
    const requestOptions = request.mock.calls[0]?.[1];
    expect(requestOptions?.method).toBe('GET');
    expect(requestOptions?.headers).toMatchObject({ authorization: 'Bearer app|secret' });
    expect(requestOptions?.body).toBeUndefined();
    expect(error).toMatchObject({
      status: 400,
      kind: 'permanent',
      diagnostic: { endpoint: 'debug_token', code: 100, subcode: 33, traceId: 'trace-123' },
    });
    expect(String(error)).not.toMatch(/private|graph detail|100|33|token|secret/);
    expect(JSON.stringify((error as MetaRequestError).diagnostic)).not.toMatch(/private|secret/);
  });

  it('rejects a normal invalid debug_token response without treating it as a transport error', async () => {
    const client = new MetaHttpClient({
      appId: 'app',
      appSecret: 'secret',
      graphVersion: 'v23.0',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response({ data: { is_valid: false } })),
    });
    await expect(
      client.validateCredential(
        { access_token: 'invalid' },
        META_FAMILY_PERMISSIONS.facebook_pages,
      ),
    ).rejects.toMatchObject({ status: 401, kind: 'auth' });
  });

  it('accepts a sanitized successful family-specific debug_token envelope', async () => {
    const client = new MetaHttpClient({
      appId: 'app',
      appSecret: 'secret',
      graphVersion: 'v23.0',
      fetch: vi.fn<typeof globalThis.fetch>().mockImplementation(() =>
        Promise.resolve(
          response({
            data: {
              is_valid: true,
              app_id: 'app',
              user_id: 'subject',
              scopes: META_FAMILY_PERMISSIONS.facebook_pages,
            },
          }),
        ),
      ),
    });
    await expect(
      client.validateCredential(
        { access_token: 'fixture-token' },
        META_FAMILY_PERMISSIONS.facebook_pages,
      ),
    ).resolves.toMatchObject({ userId: 'subject', scopes: META_FAMILY_PERMISSIONS.facebook_pages });
    await expect(
      client.validateCredential(
        { access_token: 'fixture-token' },
        META_FAMILY_PERMISSIONS.instagram,
      ),
    ).rejects.toMatchObject({ status: 403, kind: 'permission' });
  });
  it('pins version, callback, state, and the selected Page-only permission set', () => {
    const client = new MetaHttpClient({ appId: 'app', appSecret: 'secret', graphVersion: 'v23.0' });
    const url = new URL(
      client.authorizationUrl({
        redirectUri: 'https://relay.test/api/oauth/meta/callback',
        state: 's',
        permissions: META_FAMILY_PERMISSIONS.facebook_pages,
      }),
    );
    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.pathname).toBe('/v23.0/dialog/oauth');
    expect(url.searchParams.get('redirect_uri')).toBe('https://relay.test/api/oauth/meta/callback');
    expect(url.searchParams.get('state')).toBe('s');
    expect(url.searchParams.get('scope')?.split(',')).toEqual(
      META_FAMILY_PERMISSIONS.facebook_pages,
    );
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
            scopes: META_FAMILY_PERMISSIONS.facebook_pages,
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
        permissions: META_FAMILY_PERMISSIONS.facebook_pages,
      }),
    ).resolves.toMatchObject({
      accessToken: 'long',
      userId: 'meta-user-one',
      scopes: META_FAMILY_PERMISSIONS.facebook_pages,
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
      .validateCredential({ access_token: 'token' }, META_FAMILY_PERMISSIONS.facebook_pages)
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
