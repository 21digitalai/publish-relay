import { describe, expect, it, vi } from 'vitest';

import { validateLinkedInTextContent } from '../src/modules/providers/linkedin-content.js';
import {
  LinkedInHttpClient,
  LinkedInRequestError,
} from '../src/modules/providers/linkedin-http-client.js';

const options = { clientId: 'client-id', clientSecret: 'client-secret', now: () => 1_000 };

describe('LinkedIn member integration', () => {
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
