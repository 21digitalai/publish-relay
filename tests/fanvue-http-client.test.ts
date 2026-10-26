import { describe, expect, it, vi } from 'vitest';

import {
  FANVUE_PUBLISHING_SCOPES,
  FANVUE_CHAT_READ_SCOPES,
  FANVUE_PAYMENT_SCOPE,
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
  it('requests optional creator payment scope without dropping existing chat grants', async () => {
    const existingScopes = [...FANVUE_CHAT_READ_SCOPES, 'write:chat'];
    const paymentScope = [...existingScopes, FANVUE_PAYMENT_SCOPE].join(' ');
    const { client } = fixture({ ...token, scope: paymentScope });
    const url = new URL(
      client.authorizationUrl({
        redirectUri,
        state: 's'.repeat(43),
        codeChallenge: 'challenge',
        payment: true,
        existingScopes,
      }),
    );
    expect(new Set(url.searchParams.get('scope')?.split(' '))).toEqual(
      new Set(paymentScope.split(' ')),
    );
    await expect(
      client.exchangeCode({
        code: 'payment-code',
        redirectUri,
        codeVerifier: 'verifier',
        payment: true,
        requiredScopes: [...existingScopes, FANVUE_PAYMENT_SCOPE],
      }),
    ).resolves.toMatchObject({ scope: paymentScope });
    await expect(
      fixture({ ...token, scope: existingScopes.join(' ') }).client.exchangeCode({
        code: 'missing-payment',
        redirectUri,
        codeVerifier: 'verifier',
        payment: true,
        requiredScopes: [...existingScopes, FANVUE_PAYMENT_SCOPE],
      }),
    ).rejects.toThrow('payment grant');
  });
  it('accepts known chat scopes on refresh but rejects duplicate scopes', async () => {
    const expanded = FANVUE_CHAT_READ_SCOPES.join(' ');
    await expect(
      fixture({ ...token, scope: expanded }).client.refresh('old'),
    ).resolves.toMatchObject({
      scope: expanded,
    });
    await expect(
      fixture({ ...token, scope: `${expanded} write:chat` }).client.refresh('old'),
    ).resolves.toMatchObject({ scope: `${expanded} write:chat` });
    await expect(
      fixture({ ...token, scope: `${expanded} read:chat` }).client.refresh('old'),
    ).rejects.toThrow('unsupported scopes');
  });
  it('requests an explicit chat-read module without requesting send authority', async () => {
    const moduleScope = FANVUE_CHAT_READ_SCOPES.join(' ');
    const { client } = fixture({ ...token, scope: moduleScope });
    const url = new URL(
      client.authorizationUrl({
        redirectUri,
        state: 's'.repeat(43),
        codeChallenge: 'challenge',
        readChat: true,
      }),
    );
    expect(url.searchParams.get('scope')).toBe(moduleScope);
    expect(moduleScope).not.toContain('write:chat');
    await expect(
      client.exchangeCode({
        code: 'module-code',
        redirectUri,
        codeVerifier: 'verifier',
        readChat: true,
      }),
    ).resolves.toMatchObject({ scope: moduleScope });
    await expect(
      fixture(token).client.exchangeCode({
        code: 'missing-chat',
        redirectUri,
        codeVerifier: 'verifier',
        readChat: true,
      }),
    ).rejects.toThrow('chat-read grant');
  });
  it('requests chat-send authority only for the selected send module', async () => {
    const sendScope = `${FANVUE_CHAT_READ_SCOPES.join(' ')} write:chat`;
    const { client } = fixture({ ...token, scope: sendScope });
    const url = new URL(
      client.authorizationUrl({
        redirectUri,
        state: 's'.repeat(43),
        codeChallenge: 'challenge',
        sendChat: true,
      }),
    );
    expect(url.searchParams.get('scope')).toBe(sendScope);
    await expect(
      client.exchangeCode({
        code: 'send-code',
        redirectUri,
        codeVerifier: 'verifier',
        sendChat: true,
      }),
    ).resolves.toMatchObject({ scope: sendScope });
    await expect(
      fixture({ ...token, scope: FANVUE_CHAT_READ_SCOPES.join(' ') }).client.exchangeCode({
        code: 'read-only',
        redirectUri,
        codeVerifier: 'verifier',
        sendChat: true,
      }),
    ).rejects.toThrow('chat-send grant');
  });
  it('requests only base scopes and mandatory S256 PKCE', () => {
    const { client } = fixture(token);
    const url = new URL(
      client.authorizationUrl({ redirectUri, state: 's'.repeat(43), codeChallenge: 'challenge' }),
    );
    expect(url.origin).toBe('https://auth.fanvue.com');
    expect(url.searchParams.get('scope')).toBe(scope);
    expect(url.searchParams.get('scope')).toContain('read:post');
    expect(url.searchParams.get('scope')).toContain('read:media');
    expect(url.searchParams.get('scope')).not.toMatch(/chat|comment/);
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
    const { request, client } = fixture({ ...token, token_type: 'bearer' });
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
      fixture({
        ...token,
        scope: scope.replace('read:media ', '').replace('read:post ', ''),
      }).client.exchangeCode({
        code: 'code',
        redirectUri,
        codeVerifier: 'verifier',
      }),
    ).rejects.toThrow('does not match the requested scopes');
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
    expect(request.mock.calls[0]?.[0]).toBe('https://api.fanvue.com/users/me');
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer access',
      'X-Fanvue-API-Version': '2025-06-26',
    });
  });

  it('classifies invalid_grant without exposing provider error detail', async () => {
    await expect(
      fixture({ ...token, token_type: 'Basic' }).client.exchangeCode({
        code: 'code',
        redirectUri,
        codeVerifier: 'verifier',
      }),
    ).rejects.toBeInstanceOf(FanvueRequestError);
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
