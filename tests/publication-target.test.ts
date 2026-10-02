import { describe, expect, it } from 'vitest';

import {
  createPostRequestSchema,
  normalizeCreatePostRequest,
} from '../src/modules/content/post.contract.js';

const accountId = '00000000-0000-4000-8000-000000000203';
const mediaId = '00000000-0000-4000-8000-000000000204';
const scheduledAt = '2026-11-01T10:00:00.000Z';

describe('destination-first publication contract', () => {
  it('normalizes an explicit YouTube destination without inferring from media', () => {
    const request = createPostRequestSchema.parse({
      destination: { provider: 'youtube', providerAccountId: accountId },
      content: {
        schemaVersion: 1,
        kind: 'video',
        mediaId,
        providerOptions: { youtube: { schemaVersion: 1, title: 'Video' } },
      },
      scheduledAt,
    });
    expect(normalizeCreatePostRequest(request)).toMatchObject({
      selectedDestination: 'youtube',
      providerAccountIds: [accountId],
      mediaIds: [mediaId],
    });
  });

  it('rejects a provider/content discriminant mismatch', () => {
    expect(() =>
      createPostRequestSchema.parse({
        destination: { provider: 'x', providerAccountId: accountId },
        content: { schemaVersion: 1, kind: 'video', mediaId },
        scheduledAt,
      }),
    ).toThrow();
  });

  it('preserves X thread posts through destination-first normalization', () => {
    const posts = ['Opening', { text: 'Closing', mediaIds: [] }];
    const request = createPostRequestSchema.parse({
      destination: { provider: 'x', providerAccountId: accountId },
      content: { schemaVersion: 1, kind: 'thread', posts },
      scheduledAt,
    });
    expect(normalizeCreatePostRequest(request).content).toMatchObject({
      kind: 'thread',
      posts,
    });
  });

  it('does not reinterpret a malformed explicit target as legacy', () => {
    const legacy = {
      content: { kind: 'text', text: 'Hello' },
      providerAccountIds: [accountId],
      scheduledAt,
    };
    expect(
      createPostRequestSchema.safeParse({
        ...legacy,
        destination: { providerAccountId: accountId },
      }).success,
    ).toBe(false);
    expect(
      createPostRequestSchema.safeParse({
        ...legacy,
        destination: { provider: 'x', providerAccountId: accountId },
      }).success,
    ).toBe(false);
  });

  it('keeps the legacy shape for existing destinations', () => {
    const request = createPostRequestSchema.parse({
      content: { kind: 'text', text: 'Hello' },
      mediaIds: [],
      providerAccountIds: [accountId],
      scheduledAt,
    });
    expect(normalizeCreatePostRequest(request)).toEqual({
      content: { kind: 'text', text: 'Hello' },
      mediaIds: [],
      providerAccountIds: [accountId],
    });
  });

  it('recognizes TikTok video only as an explicit versioned target', () => {
    const request = createPostRequestSchema.parse({
      destination: { provider: 'tiktok', providerAccountId: accountId },
      content: {
        schemaVersion: 1,
        kind: 'video',
        caption: 'Hello',
        mediaId,
        options: {
          privacyLevel: 'SELF_ONLY',
          allowComment: false,
          allowDuet: false,
          allowStitch: false,
          commercialContent: 'none',
          aiGenerated: false,
        },
        capabilitySnapshotId: accountId,
        consentReceiptId: mediaId,
      },
      scheduledAt,
    });
    expect(normalizeCreatePostRequest(request).selectedDestination).toBe('tiktok');
  });

  it('enforces the TikTok caption boundary at the API contract', () => {
    const target = {
      provider: 'tiktok' as const,
      providerAccountId: accountId,
      content: {
        schemaVersion: 1 as const,
        kind: 'video' as const,
        caption: 'x'.repeat(2200),
        mediaId,
        options: {
          privacyLevel: 'SELF_ONLY' as const,
          allowComment: false,
          allowDuet: false,
          allowStitch: false,
          commercialContent: 'none' as const,
          aiGenerated: false,
        },
        capabilitySnapshotId: accountId,
        consentReceiptId: mediaId,
      },
    };
    expect(
      createPostRequestSchema.safeParse({
        destination: {
          provider: target.provider,
          providerAccountId: target.providerAccountId,
        },
        content: target.content,
        scheduledAt,
      }).success,
    ).toBe(true);
    expect(
      createPostRequestSchema.safeParse({
        destination: {
          provider: target.provider,
          providerAccountId: target.providerAccountId,
        },
        content: { ...target.content, caption: 'x'.repeat(2201) },
        scheduledAt,
      }).success,
    ).toBe(false);
  });
});
