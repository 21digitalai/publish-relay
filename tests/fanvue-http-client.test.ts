import { describe, expect, it, vi } from 'vitest';

import {
  FANVUE_PUBLISHING_SCOPES,
  FanvueHttpClient,
  FanvueRequestError,
} from '../src/modules/providers/fanvue-http-client.js';

const scope = FANVUE_PUBLISHING_SCOPES.join(' ');
const token = {
  access_token: 'access',
  refresh_token: 'refresh',
  token_type: 'Bearer',
  expires_in: 3600,
  scope,
};
const redirectUri = 'https://publishrelay.app/api/oauth/fanvue/callback';

function fixture(body: unknown, status = 200) {
  const request = vi.fn<typeof fetch>().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  return {
    request,
    client: new FanvueHttpClient({ clientId: 'id', clientSecret: 'secret', fetch: request }),
  };
}

describe('Fanvue publishing-only OAuth transport', () => {
  it('requests only base scopes and mandatory S256 PKCE', () => {
    const { client } = fixture(token);
    const url = new URL(
      client.authorizationUrl({ redirectUri, state: 's'.repeat(43), codeChallenge: 'challenge' }),
    );
    expect(url.origin).toBe('https://auth.fanvue.com');
    expect(url.searchParams.get('scope')).toBe(scope);
    expect(url.searchParams.get('scope')).not.toMatch(/chat|comment|read:post|read:media/);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(() =>
      client.authorizationUrl({
        redirectUri: 'http://relay.test/callback',
        state: 's'.repeat(43),
        codeChallenge: 'challenge',
      }),
    ).toThrow();
  });

  it('uses confidential Basic auth, original verifier, and rotating refresh token', async () => {
    const { request, client } = fixture(token);
    await client.exchangeCode({ code: 'one-use-code', redirectUri, codeVerifier: 'verifier' });
    await client.refresh('old-refresh');
    for (const call of request.mock.calls) {
      expect(call[0]).toBe('https://auth.fanvue.com/oauth2/token');
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
      const body = call[1]?.body as URLSearchParams;
      expect(body.has('client_id')).toBe(false);
      expect(body.has('client_secret')).toBe(false);
    }
    expect((request.mock.calls[0]?.[1]?.body as URLSearchParams).get('code_verifier')).toBe(
      'verifier',
    );
    expect((request.mock.calls[1]?.[1]?.body as URLSearchParams).get('refresh_token')).toBe(
      'old-refresh',
    );
  });

  it('rejects missing publishing scope and non-creator identity', async () => {
    await expect(
      fixture({ ...token, scope: 'openid read:self' }).client.exchangeCode({
        code: 'code',
        redirectUri,
        codeVerifier: 'verifier',
      }),
    ).rejects.toThrow('does not match the requested scopes');
    await expect(
      fixture({ ...token, scope: `${scope} read:chat` }).client.exchangeCode({
        code: 'code',
        redirectUri,
        codeVerifier: 'verifier',
      }),
    ).rejects.toThrow('does not match the requested scopes');
    const fan = { uuid: 'd6ed1cac-e0cd-4109-bf04-539cb8591838', isCreator: false };
    await expect(fixture(fan).client.discoverCreator('access')).rejects.toThrow('creator account');
    const creator = { ...fan, isCreator: true, displayName: 'Creator' };
    const { client, request } = fixture(creator);
    await expect(client.discoverCreator('access')).resolves.toEqual(creator);
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer access',
      'X-Fanvue-API-Version': '2025-06-26',
    });
  });

  it('classifies invalid_grant without exposing provider error detail', async () => {
    await expect(
      fixture({ error: 'invalid_grant', error_description: 'sensitive' }, 400).client.refresh(
        'old',
      ),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_grant' });
    await expect(
      fixture({ error: 'invalid_client' }, 401).client.refresh('old'),
    ).rejects.toBeInstanceOf(FanvueRequestError);
  });
});
