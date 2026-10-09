import { describe, expect, it, vi } from 'vitest';

import {
  InstagramLoginAccountError,
  InstagramLoginClient,
  InstagramLoginPermissionError,
} from '../src/modules/providers/instagram-login-client.js';

const appId = '856816254187944';
const callback = 'https://publishrelay.app/api/oauth/instagram/callback';

function clientWithResponses(responses: unknown[]) {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const request = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: new URL(input instanceof Request ? input.url : input), init });
    return Promise.resolve(
      new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return {
    requests,
    client: new InstagramLoginClient({
      appId,
      appSecret: 'separate-instagram-secret',
      graphVersion: 'v23.0',
      fetch: request,
      now: () => Date.parse('2026-10-09T11:00:00Z'),
    }),
  };
}

describe('Instagram Login transport', () => {
  it('requests only Instagram scopes and uses only Instagram token and profile hosts', async () => {
    const { client, requests } = clientWithResponses([
      {
        access_token: 'short-token',
        user_id: 'app-scoped-1',
        permissions: ['instagram_business_basic', 'instagram_business_content_publish'],
      },
      { access_token: 'long-token', expires_in: 3600 },
      {
        id: 'app-scoped-1',
        user_id: 'remote-user-1',
        username: 'publisher',
        account_type: 'BUSINESS',
      },
    ]);
    const authorize = new URL(client.authorizationUrl({ redirectUri: callback, state: 'nonce' }));
    expect(authorize.origin).toBe('https://www.instagram.com');
    expect(authorize.searchParams.get('scope')).toBe(
      'instagram_business_basic,instagram_business_content_publish',
    );
    expect(authorize.searchParams.get('redirect_uri')).toBe(callback);
    expect(authorize.toString()).not.toContain('pages_');
    expect(await client.exchangeCode({ code: 'one-use-code', redirectUri: callback })).toEqual({
      accessToken: 'long-token',
      appScopedUserId: 'app-scoped-1',
      remoteUserId: 'remote-user-1',
      username: 'publisher',
      expiresAt: new Date('2026-10-09T12:00:00Z'),
    });
    expect(requests.map((entry) => entry.url.origin)).toEqual([
      'https://api.instagram.com',
      'https://graph.instagram.com',
      'https://graph.instagram.com',
    ]);
    expect(requests[0]?.init?.method).toBe('POST');
    expect(requests[2]?.url.pathname).toBe('/v23.0/me');
  });

  it('rejects partial permission and ineligible or mismatched accounts before persistence', async () => {
    const partial = clientWithResponses([
      { access_token: 'short', user_id: 'one', permissions: ['instagram_business_basic'] },
    ]);
    await expect(
      partial.client.exchangeCode({ code: 'code', redirectUri: callback }),
    ).rejects.toBeInstanceOf(InstagramLoginPermissionError);
    expect(partial.requests).toHaveLength(1);
    const personal = clientWithResponses([
      {
        access_token: 'short',
        user_id: 'one',
        permissions: ['instagram_business_basic', 'instagram_business_content_publish'],
      },
      { access_token: 'long', expires_in: 3600 },
      { id: 'one', user_id: 'remote', username: 'person', account_type: 'PERSONAL' },
    ]);
    await expect(
      personal.client.exchangeCode({ code: 'code', redirectUri: callback }),
    ).rejects.toBeInstanceOf(InstagramLoginAccountError);
  });

  it('refreshes a long-lived Instagram token without touching Facebook hosts', async () => {
    const { client, requests } = clientWithResponses([
      { access_token: 'refreshed', expires_in: 7200 },
    ]);
    expect(await client.refreshToken('old-token')).toEqual({
      accessToken: 'refreshed',
      expiresAt: new Date('2026-10-09T13:00:00Z'),
    });
    expect(requests[0]?.url.origin).toBe('https://graph.instagram.com');
    expect(requests[0]?.url.searchParams.get('grant_type')).toBe('ig_refresh_token');
  });
});
