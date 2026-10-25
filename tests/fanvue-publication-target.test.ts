import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { destinationCreatePostRequestSchema } from '../src/modules/content/post.contract.js';
import {
  normalizePublicationTarget,
  publicationTargetSchema,
} from '../src/modules/content/publication-target.js';

const accountId = randomUUID();
const mediaId = randomUUID();
const base = {
  destination: { provider: 'fanvue', providerAccountId: accountId },
  scheduledAt: '2026-10-25T12:00:00.000Z',
};

describe('Fanvue destination-first post contract', () => {
  it('preserves explicit free and priced audience choices with local media identity', () => {
    const free = destinationCreatePostRequestSchema.parse({
      ...base,
      content: {
        schemaVersion: 1,
        kind: 'post',
        audience: 'followers-and-subscribers',
        text: 'Hello',
      },
    });
    const freeTarget = publicationTargetSchema.parse({
      ...free.destination,
      content: free.content,
    });
    expect(normalizePublicationTarget(freeTarget)).toMatchObject({
      provider: 'fanvue',
      providerAccountId: accountId,
      mediaIds: [],
      content: { audience: 'followers-and-subscribers', text: 'Hello' },
    });
    const priced = destinationCreatePostRequestSchema.parse({
      ...base,
      content: {
        schemaVersion: 1,
        kind: 'post',
        audience: 'subscribers',
        mediaIds: [mediaId],
        mediaPreviewId: mediaId,
        price: 300,
      },
    });
    expect(
      normalizePublicationTarget(
        publicationTargetSchema.parse({ ...priced.destination, content: priced.content }),
      ).mediaIds,
    ).toEqual([mediaId]);
  });

  it('rejects empty, under-minimum paid, unattached preview and paid text-only posts', () => {
    const content = { schemaVersion: 1, kind: 'post', audience: 'subscribers' };
    for (const invalid of [
      content,
      { ...content, mediaIds: [mediaId], price: 299 },
      { ...content, mediaIds: [mediaId], mediaPreviewId: randomUUID() },
      { ...content, text: 'Paid', price: 300 },
    ])
      expect(
        destinationCreatePostRequestSchema.safeParse({ ...base, content: invalid }).success,
      ).toBe(false);
  });
});
