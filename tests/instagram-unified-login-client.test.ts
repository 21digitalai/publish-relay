import { describe, expect, it } from 'vitest';
import { InstagramUnifiedLoginClient } from '../src/modules/providers/instagram-unified-login-client.js';

describe('Instagram Unified Login client', () => {
  it('builds the Facebook Login for Business URL with config_id', () => {
    const client = new InstagramUnifiedLoginClient({
      appId: 'app',
      appSecret: 'secret',
      configId: 'config',
      graphVersion: 'v27.0',
    });
    const url = new URL(
      client.authorizationUrl({ redirectUri: 'https://relay.test/callback', state: 'state' }),
    );
    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.pathname).toBe('/v27.0/dialog/oauth');
    expect(url.searchParams.get('config_id')).toBe('config');
    expect(url.searchParams.get('scope')).toBeNull();
  });

  it('exchanges and discovers multiple accounts with bounded paging', async () => {
    const requests: URL[] = [];
    const client = new InstagramUnifiedLoginClient({
      appId: 'app',
      appSecret: 'secret',
      configId: 'config',
      graphVersion: 'v27.0',
      now: () => 1_000,
      fetch: async (input) => {
        const url = new URL(String(input));
        requests.push(url);
        if (url.pathname.endsWith('/oauth/access_token'))
          return new Response(JSON.stringify({ access_token: 'token', expires_in: 60 }), {
            status: 200,
          });
        if (url.pathname.endsWith('/me'))
          return new Response(
            JSON.stringify({ id: 'system-user', client_business_id: 'business' }),
            { status: 200 },
          );
        return new Response(
          JSON.stringify({ data: [{ id: 'ig-1', username: 'one' }], paging: {} }),
          { status: 200 },
        );
      },
    });
    await expect(
      client.exchangeCode({ code: 'one-use', redirectUri: 'https://relay.test/callback' }),
    ).resolves.toMatchObject({
      appScopedUserId: 'system-user',
      clientBusinessId: 'business',
      accounts: [{ id: 'ig-1' }],
    });
    expect(requests.map((url) => url.pathname)).toEqual([
      '/v27.0/oauth/access_token',
      '/v27.0/me',
      '/v27.0/me/assigned_instagram_accounts',
    ]);
    expect(requests[0]?.searchParams.get('client_secret')).toBe('secret');
  });
});
