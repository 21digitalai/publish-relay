import { describe, expect, it, vi } from 'vitest';

import {
  SnapchatHttpClient,
  SnapchatRequestError,
} from '../src/modules/providers/snapchat-http-client.js';

const token = {
  access_token: 'access',
  refresh_token: 'refresh',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'snapchat-profile-api',
};

function client(response: unknown, status = 200) {
  const request = vi.fn<typeof fetch>().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  return {
    request,
    api: new SnapchatHttpClient({ clientId: 'client', clientSecret: 'secret', fetch: request }),
  };
}

describe('Snapchat fixture-only OAuth transport', () => {
  it('constructs the owner-scoped authorization request with the caller state', () => {
    const { api } = client(token);
    const url = new URL(
      api.authorizationUrl({
        redirectUri: 'https://publishrelay.app/api/oauth/snapchat/callback',
        state: 'one-use-state',
      }),
    );
    expect(url.origin).toBe('https://accounts.snapchat.com');
    expect(url.searchParams.get('scope')).toBe('snapchat-profile-api');
    expect(url.searchParams.get('state')).toBe('one-use-state');
    expect(() =>
      api.authorizationUrl({ redirectUri: 'http://localhost/callback', state: 'state' }),
    ).toThrow();
  });

  it('exchanges and refreshes tokens without exposing client credentials in URLs', async () => {
    const { api, request } = client(token);
    await expect(
      api.exchangeCode({
        code: 'code',
        redirectUri: 'https://publishrelay.app/api/oauth/snapchat/callback',
      }),
    ).resolves.toEqual(token);
    await expect(api.refreshToken('old-refresh')).resolves.toEqual(token);
    const first = request.mock.calls[0];
    const second = request.mock.calls[1];
    expect(first?.[0]).toBe('https://accounts.snapchat.com/login/oauth2/access_token');
    expect(first?.[1]?.redirect).toBe('error');
    const firstBody = first?.[1]?.body;
    const secondBody = second?.[1]?.body;
    expect(firstBody).toBeInstanceOf(URLSearchParams);
    expect(secondBody).toBeInstanceOf(URLSearchParams);
    if (!(firstBody instanceof URLSearchParams) || !(secondBody instanceof URLSearchParams))
      throw new Error('Snapchat OAuth token request must use form encoding');
    expect(firstBody.get('grant_type')).toBe('authorization_code');
    expect(secondBody.get('grant_type')).toBe('refresh_token');
  });

  it('discovers only the token-owner profile and rejects malformed or denied responses', async () => {
    const profile = { id: 'd6ed1cac-e0cd-4109-bf04-539cb8591838', display_name: 'Owner profile' };
    const { api, request } = client({ request_status: 'SUCCESS', public_profile: profile });
    await expect(api.discoverOwnerProfile('access')).resolves.toEqual(profile);
    expect(request.mock.calls[0]?.[0]).toBe(
      'https://businessapi.snapchat.com/v1/public_profiles/my_profile',
    );
    expect(request.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: 'Bearer access' });
    await expect(
      client({ request_status: 'ERROR' }).api.discoverOwnerProfile('access'),
    ).rejects.toBeInstanceOf(SnapchatRequestError);
    await expect(
      client({ request_status: 'SUCCESS', public_profile: profile }, 403).api.discoverOwnerProfile(
        'access',
      ),
    ).rejects.toBeInstanceOf(SnapchatRequestError);
    await expect(
      client({ ...token, scope: 'snapchat-marketing-api' }).api.exchangeCode({
        code: 'code',
        redirectUri: 'https://publishrelay.app/callback',
      }),
    ).rejects.toBeInstanceOf(SnapchatRequestError);
  });
});
