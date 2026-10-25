import { describe, expect, it } from 'vitest';

import { fanvuePostContent, fanvuePriceCents } from '../src/ui/fanvue-composer.js';
import {
  createPostRequestSchema,
  normalizeCreatePostRequest,
} from '../src/modules/content/post.contract.js';

const accountId = '00000000-0000-4000-8000-000000000021';
const mediaId = '00000000-0000-4000-8000-000000000022';

describe('Fanvue Composer request', () => {
  it('keeps free posts free and preserves the selected audience and media', () => {
    expect(
      fanvuePostContent({
        audience: 'followers-and-subscribers',
        text: ' Hello ',
        mediaIds: ['media-a'],
        price: '',
      }),
    ).toEqual({
      schemaVersion: 1,
      kind: 'post',
      audience: 'followers-and-subscribers',
      text: 'Hello',
      mediaIds: ['media-a'],
    });
  });

  it('converts explicit USD to integer cents without a floating-point rounding path', () => {
    expect(fanvuePriceCents('3')).toBe(300);
    expect(fanvuePriceCents('3.05')).toBe(305);
    expect(fanvuePriceCents('3.5')).toBe(350);
    expect(
      fanvuePostContent({ audience: 'subscribers', text: '', mediaIds: ['media-a'], price: '3.05' })
        .price,
    ).toBe(305);
  });

  it('admits the destination-first browser shape to one canonical Fanvue account and media list', () => {
    const request = createPostRequestSchema.parse({
      destination: { provider: 'fanvue', providerAccountId: accountId },
      content: fanvuePostContent({
        audience: 'subscribers',
        text: 'New clip',
        mediaIds: [mediaId],
        price: '3.05',
      }),
      scheduledAt: '2026-10-26T09:00:00.000Z',
    });
    expect(normalizeCreatePostRequest(request)).toMatchObject({
      selectedDestination: 'fanvue',
      providerAccountIds: [accountId],
      mediaIds: [mediaId],
      content: { kind: 'post', audience: 'subscribers', price: 305 },
    });
  });

  it('rejects invalid prices and paid text-only posts', () => {
    expect(Number.isNaN(fanvuePriceCents('2.99'))).toBe(true);
    expect(Number.isNaN(fanvuePriceCents('3.005'))).toBe(true);
    expect(() =>
      fanvuePostContent({ audience: 'subscribers', text: 'Hello', mediaIds: [], price: '3' }),
    ).toThrow('Add media');
    expect(() =>
      fanvuePostContent({ audience: 'subscribers', text: '', mediaIds: [], price: '' }),
    ).toThrow('Add text or media');
  });
});
