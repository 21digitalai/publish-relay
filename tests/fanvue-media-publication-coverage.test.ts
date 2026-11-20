import { describe, expect, it, vi } from 'vitest';

import { FanvueRequestError } from '../src/modules/providers/fanvue-http-client.js';
import { FanvueReadService } from '../src/modules/providers/fanvue-read.service.js';

const input = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  mediaUuid: '00000000-0000-4000-8000-000000000003',
};
const postUuid = '00000000-0000-4000-8000-000000000004';

function post(overrides: Record<string, unknown> = {}) {
  return {
    uuid: postUuid,
    createdAt: '2026-11-20T10:00:00.000Z',
    publishedAt: '2026-11-20T10:05:00.000Z',
    textPreview: null,
    audience: 'followers-and-subscribers',
    price: null,
    mediaUuids: [],
    commentsCount: 0,
    ...overrides,
  };
}

function fixture(pages: unknown[], manualPostsIncluded = false) {
  const listPosts = vi.fn();
  for (const page of pages) {
    if (page instanceof Error) listPosts.mockRejectedValueOnce(page);
    else listPosts.mockResolvedValueOnce(page);
  }
  const service = new FanvueReadService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { manualPostsIncluded },
  );
  Reflect.set(service, 'accessToken', vi.fn().mockResolvedValue('token'));
  Reflect.set(service, 'readClient', { listPosts });
  return { service, listPosts };
}

describe('Fanvue media publication coverage', () => {
  it('proves a published exact UUID match across overlapping pages', async () => {
    const context = fixture([
      { data: [post()], nextCursor: 'next' },
      { data: [post({ mediaUuids: [input.mediaUuid] })], nextCursor: 'later' },
    ]);
    await expect(context.service.getMediaPublicationCoverage(input)).resolves.toMatchObject({
      state: 'posted',
      complete: false,
      pagesScanned: 2,
      uniquePostsScanned: 1,
      matchingPostUuid: postUuid,
      publishedAt: new Date('2026-11-20T10:05:00.000Z'),
      incompleteReason: null,
    });
  });

  it('keeps a complete scan unknown until manual-post coverage is verified', async () => {
    const context = fixture([{
      data: [post({ publishedAt: null, mediaUuids: [input.mediaUuid] })],
      nextCursor: null,
    }]);
    await expect(context.service.getMediaPublicationCoverage(input)).resolves.toMatchObject({
      state: 'unknown',
      complete: true,
      pagesScanned: 1,
      uniquePostsScanned: 1,
      incompleteReason: 'manual_post_coverage_unverified',
    });
  });

  it('proves unposted after complete history when manual-post coverage is verified', async () => {
    const context = fixture([
      {
        data: [post({ publishedAt: null, mediaUuids: [input.mediaUuid] })],
        nextCursor: null,
      },
    ], true);
    await expect(context.service.getMediaPublicationCoverage(input)).resolves.toMatchObject({
      state: 'unposted',
      complete: true,
      pagesScanned: 1,
      uniquePostsScanned: 1,
      incompleteReason: null,
    });
  });

  it('returns unknown for a partial provider failure', async () => {
    const context = fixture([
      { data: [post()], nextCursor: 'next' },
      new FanvueRequestError(503),
    ]);
    await expect(context.service.getMediaPublicationCoverage(input)).resolves.toMatchObject({
      state: 'unknown',
      complete: false,
      pagesScanned: 1,
      uniquePostsScanned: 1,
      incompleteReason: 'scan_failed',
    });
  });

  it('returns unknown when the bounded scan is capped', async () => {
    const context = fixture([{ data: [post()], nextCursor: 'next' }]);
    await expect(
      context.service.getMediaPublicationCoverage({ ...input, maxPages: 1 }),
    ).resolves.toMatchObject({
      state: 'unknown',
      complete: false,
      pagesScanned: 1,
      uniquePostsScanned: 1,
      incompleteReason: 'scan_capped',
    });
  });
});
