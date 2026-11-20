import { describe, expect, it, vi } from 'vitest';

import { FanvueReadClient } from '../src/modules/providers/fanvue-read-client.js';

const person = { uuid: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', handle: 'fan' };
const message = {
  uuid: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  text: 'hello',
  sentAt: '2026-03-04T18:21:09.000Z',
  sender: person,
  recipient: person,
  type: 'SINGLE_RECIPIENT',
  pricing: { USD: { price: 1500 } },
  purchasedAt: null,
  tipSource: null,
  expiringMediaUrl: 'must-not-escape',
};

describe('Fanvue read transport', () => {
  it.each([true, false])(
    'reads explicit purchasedByFan=%s without inference',
    async (purchased) => {
      const mediaUuid = '0b4a3c1e-2f6d-4b8a-9c1d-5e7f8a9b0c1d';
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ uuid: mediaUuid, status: 'ready', purchasedByFan: purchased }),
        );
      await expect(
        new FanvueReadClient(request).getMediaPurchaseFact('token', mediaUuid, person.uuid),
      ).resolves.toMatchObject({ purchasedByFan: purchased });
      expect(request.mock.calls[0]?.[0]).toContain(`purchasedBy=${person.uuid}`);
    },
  );

  it('keeps a missing purchasedByFan field unknown instead of false', async () => {
    const mediaUuid = '0b4a3c1e-2f6d-4b8a-9c1d-5e7f8a9b0c1d';
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ uuid: mediaUuid, status: 'ready' }));
    await expect(
      new FanvueReadClient(request).getMediaPurchaseFact('token', mediaUuid, person.uuid),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('paginates chats and never marks message reads', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation((url) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: (typeof url === 'string'
              ? url
              : url instanceof URL
                ? url.href
                : url.url
            ).includes('/messages')
              ? [message]
              : [{ user: person, isRead: false, unreadMessagesCount: 2 }],
            pagination: { page: 2, size: 1, hasMore: true },
          }),
        ),
      ),
    );
    const client = new FanvueReadClient(request);
    await expect(
      client.listChats('token', { page: 2, size: 50, unreadOnly: true }),
    ).resolves.toMatchObject({ data: [{ unreadMessagesCount: 2 }], pagination: { hasMore: true } });
    const messages = await client.listMessages('token', person.uuid, { page: 3 });
    expect(messages.data[0]).toMatchObject({ pricing: { USD: { price: 1500 } } });
    expect(messages.data[0]).not.toHaveProperty('expiringMediaUrl');
    expect(request.mock.calls[0]?.[0]).toContain('filter=unread');
    expect(request.mock.calls[1]?.[0]).toContain('markAsRead=false');
    expect(request.mock.calls[1]?.[1]?.method).toBeUndefined();
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer token' });
    expect(() => client.listMessages('token', '../other')).toThrow();
  });

  it.each([400, 401, 403, 429, 503])(
    'classifies HTTP %i without returning provider body',
    async (status) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('private provider detail', { status }));
      await expect(new FanvueReadClient(request).listChats('token')).rejects.toMatchObject({
        status,
        message: `Fanvue request failed (HTTP ${String(status)})`,
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['network rejection', new TypeError('private network detail')],
    ['timeout', new DOMException('private timeout detail', 'TimeoutError')],
  ])('classifies %s as a safe provider failure', async (_label, cause) => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(cause);
    await expect(new FanvueReadClient(request).listChats('token')).rejects.toMatchObject({
      status: 502,
      code: 'transport_failure',
      message: 'Fanvue request failed (HTTP 502)',
    });
  });

  it('classifies a successful non-JSON response without leaking its body', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('private malformed body'));
    await expect(new FanvueReadClient(request).listChats('token')).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response',
      message: 'Fanvue request failed (HTTP 502)',
    });
  });

  it('rejects provider pages beyond the bounded read contract', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: Array.from({ length: 51 }, () => ({
          uuid: '0b4a3c1e-2f6d-4b8a-9c1d-5e7f8a9b0c1d',
          status: 'ready',
        })),
        pagination: { page: 1, size: 51, hasMore: false },
      }),
    );
    await expect(new FanvueReadClient(request).listMedia('token')).rejects.toMatchObject({
      status: 200,
      code: 'invalid_response',
    });
  });

  it('returns stable media status without leaking expiring variant URLs', async () => {
    const mediaUuid = '0b4a3c1e-2f6d-4b8a-9c1d-5e7f8a9b0c1d';
    const item = {
      uuid: mediaUuid,
      status: 'ready',
      variants: [{ url: 'https://temporary.example/secret', variantType: 'main' }],
    };
    const request = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      return Promise.resolve(
        new Response(
          JSON.stringify(
            path.includes('/media?')
              ? { data: [item], pagination: { page: 2, size: 1, hasMore: false } }
              : item,
          ),
        ),
      );
    });
    const client = new FanvueReadClient(request);
    await expect(client.listMedia('token', { page: 2, size: 20 })).resolves.toEqual({
      data: [{ uuid: mediaUuid, status: 'ready' }],
      pagination: { page: 2, size: 1, hasMore: false },
    });
    await expect(client.getMediaStatus('token', mediaUuid)).resolves.toEqual({
      uuid: mediaUuid,
      status: 'ready',
    });
    expect(request.mock.calls[0]?.[0]).toContain('page=2&size=20');
    expect(() => client.getMediaStatus('token', '../other')).toThrow();
  });

  it('requests all documented preview fallbacks for ready vault media', async () => {
    const mediaUuid = '0b4a3c1e-2f6d-4b8a-9c1d-5e7f8a9b0c1d';
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        uuid: mediaUuid,
        status: 'ready',
        variants: [
          {
            variantType: 'main',
            url: 'https://media.fanvue.com/private/main.jpg',
          },
          {
            variantType: 'thumbnail_gallery',
            url: 'https://media.fanvue.com/private/gallery.jpg',
          },
        ],
      }),
    );

    await expect(
      new FanvueReadClient(request).getMediaThumbnail('token', mediaUuid),
    ).resolves.toMatchObject({
      status: 'ready',
      variants: [{ variantType: 'main' }, { variantType: 'thumbnail_gallery' }],
    });
    expect(request.mock.calls[0]?.[0]).toContain('?variants=main,thumbnail,thumbnail_gallery');
  });

  it('lists vault folders and URL-encodes folder names while projecting stable media facts', async () => {
    const mediaUuid = '0b4a3c1e-2f6d-4b8a-9c1d-5e7f8a9b0c1d';
    const request = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      return Promise.resolve(
        Response.json(
          path.includes('/media?')
            ? {
                data: [
                  {
                    uuid: mediaUuid,
                    status: 'ready',
                    name: 'Approved image',
                    mediaType: 'image',
                    url: 'https://temporary.example/private',
                    variants: [{ url: 'https://temporary.example/private-variant' }],
                  },
                  { uuid: '123e4567-e89b-12d3-a456-426614174000', status: 'processing' },
                ],
                pagination: { page: 2, size: 2, hasMore: false },
              }
            : {
                data: [{ name: 'DMs / Български', createdAt: null, mediaCount: 7 }],
                pagination: { page: 1, size: 1, hasMore: false },
              },
        ),
      );
    });
    const client = new FanvueReadClient(request);
    await expect(
      client.listVaultFolders('token', { mediaName: 'Foxy AI', size: 50 }),
    ).resolves.toEqual({
      data: [{ name: 'DMs / Български', createdAt: null, mediaCount: 7 }],
      pagination: { page: 1, size: 1, hasMore: false },
    });
    const page = await client.listVaultFolderMedia('token', 'DMs / Български', { page: 2 });
    expect(page.data).toEqual([
      { uuid: mediaUuid, status: 'ready', name: 'Approved image', mediaType: 'image' },
      { uuid: '123e4567-e89b-12d3-a456-426614174000', status: 'processing' },
    ]);
    expect(page.data[0]).not.toHaveProperty('url');
    expect(request.mock.calls[0]?.[0]).toContain('mediaName=Foxy+AI');
    expect(request.mock.calls[1]?.[0]).toContain(
      '/vault/folders/DMs%20%2F%20%D0%91%D1%8A%D0%BB%D0%B3%D0%B0%D1%80%D1%81%D0%BA%D0%B8/media?page=2',
    );
  });

  it('fails closed on malformed vault folder payloads and invalid names', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [{ uuid: 'not-a-uuid', status: 'ready', url: 'https://private.example' }],
        pagination: { page: 1, size: 1, hasMore: false },
      }),
    );
    const client = new FanvueReadClient(request);
    await expect(client.listVaultFolderMedia('token', 'DMs')).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(() => client.listVaultFolderMedia('token', '')).toThrow();
  });

  it('returns bounded post summaries and cursor-paginated comments', async () => {
    const postUuid = '123e4567-e89b-12d3-a456-426614174000';
    const post = {
      uuid: postUuid,
      createdAt: '2025-01-01T12:00:00.000Z',
      publishedAt: '2025-01-01T12:00:00.000Z',
      text: 'x'.repeat(5000),
      audience: 'subscribers',
      price: 300,
      mediaUuids: [],
      mediaPreviewUuid: null,
      commentsCount: 1,
      credential: 'private',
    };
    const comment = {
      uuid: '550e8400-e29b-41d4-a716-446655440001',
      text: 'Hello',
      createdAt: '2025-01-02T12:00:00.000Z',
      updatedAt: null,
      user: { ...person, displayName: 'Fan' },
      privateNote: 'private',
    };
    const request = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      return Promise.resolve(
        new Response(
          JSON.stringify(
            path.includes('/comments?')
              ? { data: [comment], nextCursor: 'next-comment' }
              : path.includes('/posts?')
                ? { data: [post], nextCursor: 'next-post' }
                : post,
          ),
        ),
      );
    });
    const client = new FanvueReadClient(request);
    const posts = await client.listPosts('token', { size: 2, cursor: 'prior' });
    expect(posts.nextCursor).toBe('next-post');
    expect(posts.data[0]?.textPreview).toHaveLength(280);
    expect(posts.data[0]).not.toHaveProperty('text');
    expect(posts.data[0]).not.toHaveProperty('credential');
    const detail = await client.getPost('token', postUuid);
    expect(detail.text).toHaveLength(5000);
    expect(detail).not.toHaveProperty('credential');
    const comments = await client.listComments('token', postUuid, { cursor: 'next-comment' });
    expect(comments.nextCursor).toBe('next-comment');
    expect(comments.data[0]).not.toHaveProperty('privateNote');
    expect(request.mock.calls[0]?.[0]).toContain('cursor=prior');
    expect(request.mock.calls[2]?.[0]).toContain('cursor=next-comment');
    expect(() => client.listComments('token', '../other')).toThrow();
  });
  it('bounds and projects follower and subscriber pages without financial fields', async () => {
    const fan = { ...person, displayName: 'Fan', isTopSpender: true, privateNote: 'hidden' };
    const request = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      return Promise.resolve(
        new Response(
          JSON.stringify(
            path.includes('/followers')
              ? { data: [fan], pagination: { page: 2, size: 1, hasMore: true } }
              : {
                  data: [
                    {
                      ...fan,
                      subscription: { status: 'active', price: 999, amountPaid: 999 },
                      firstSubscribedAt: '2026-01-01T00:00:00Z',
                    },
                  ],
                  pagination: { page: 2, size: 1, hasMore: true, nextCursor: 'next' },
                },
          ),
        ),
      );
    });
    const client = new FanvueReadClient(request);
    const followers = await client.listFollowers('token', { page: 2, size: 50 });
    expect(followers.data[0]).toEqual({
      uuid: person.uuid,
      handle: 'fan',
      displayName: 'Fan',
      relationship: 'follower',
      subscriptionStatus: null,
    });
    const subscribers = await client.listSubscribers('token', { cursor: 'prior', size: 25 });
    expect(subscribers.data[0]).toMatchObject({
      relationship: 'subscriber',
      subscriptionStatus: 'active',
    });
    expect(subscribers.data[0]).not.toHaveProperty('price');
    expect(subscribers.data[0]).not.toHaveProperty('amountPaid');
    expect(subscribers.data[0]).not.toHaveProperty('firstSubscribedAt');
    expect(subscribers.data[0]).not.toHaveProperty('isTopSpender');
    expect(request.mock.calls[0]?.[0]).toContain('page=2&size=50');
    expect(request.mock.calls[1]?.[0]).toContain('cursor=prior');
    expect(() => client.listFollowers('token', { size: 51 })).toThrow();
  });
});
