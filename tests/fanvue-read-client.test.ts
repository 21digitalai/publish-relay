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

  it('classifies provider failure without returning provider body', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('secret', { status: 429 }));
    await expect(new FanvueReadClient(request).listChats('token')).rejects.toMatchObject({
      status: 429,
    });
    expect(request).toHaveBeenCalledTimes(1);
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
});
