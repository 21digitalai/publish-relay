import { describe, expect, it } from 'vitest';

import { providerPostUrl, validatedPostUrl } from '../src/modules/providers/post-url.js';

describe('provider post links', () => {
  it('accepts only HTTPS URLs on the matching provider host', () => {
    expect(validatedPostUrl('https://www.facebook.com/page/posts/123', 'facebook_page')).toBe(
      'https://www.facebook.com/page/posts/123',
    );
    for (const url of [
      'http://facebook.com/post',
      'https://facebook.com.evil.test/post',
      'https://user:password@facebook.com/post',
      'https://instagram.com/post',
      'javascript:alert(1)',
    ])
      expect(validatedPostUrl(url, 'facebook_page')).toBeNull();
  });

  it('uses a historical Facebook ID fallback and no speculative Instagram link', () => {
    expect(providerPostUrl({ provider: 'facebook_page', id: 'page_123' })).toBe(
      'https://www.facebook.com/page_123',
    );
    expect(providerPostUrl({ provider: 'instagram', id: 'unknown-media-id' })).toBeNull();
  });

  it('preserves provider-specific links across the supported destinations', () => {
    expect(
      providerPostUrl({
        provider: 'instagram',
        id: 'media-id',
        storedUrl: 'https://www.instagram.com/p/permalink/',
      }),
    ).toBe('https://www.instagram.com/p/permalink/');
    expect(providerPostUrl({ provider: 'x', id: '42', handle: 'relay' })).toBe(
      'https://x.com/relay/status/42',
    );
    expect(providerPostUrl({ provider: 'youtube', id: 'video-1' })).toBe(
      'https://www.youtube.com/watch?v=video-1',
    );
    expect(providerPostUrl({ provider: 'linkedin', id: 'urn:li:share:42' })).toBe(
      'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A42/',
    );
  });
});
