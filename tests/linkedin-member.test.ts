import { describe, expect, it, vi } from 'vitest';

import {
  parseLinkedInContent,
  validateLinkedInTextContent,
} from '../src/modules/providers/linkedin-content.js';
import { classifyLinkedInDispatchFailure } from '../src/modules/providers/linkedin-dispatch.service.js';
import {
  LinkedInHttpClient,
  LinkedInRequestError,
} from '../src/modules/providers/linkedin-http-client.js';

const options = { clientId: 'client-id', clientSecret: 'client-secret', now: () => 1_000 };

describe('LinkedIn member integration', () => {
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
