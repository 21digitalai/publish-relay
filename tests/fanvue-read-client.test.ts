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
          }),
        ),
      ),
    );
    const client = new FanvueReadClient(request);
    await expect(
      client.listChats('token', { page: 2, size: 50, unreadOnly: true }),
    ).resolves.toMatchObject({ data: [{ unreadMessagesCount: 2 }] });
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
});
