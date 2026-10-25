import { describe, expect, it, vi } from 'vitest';

import {
  FanvuePostClient,
  FanvuePostOutcomeUnknownError,
} from '../src/modules/providers/fanvue-post-client.js';

const mediaUuid = '0b4a3c1e-2f6d-4b8a-9c1d-5e7f8a9b0c1d';
const postUuid = '123e4567-e89b-12d3-a456-426614174000';
const result = {
  uuid: postUuid,
  createdAt: '2025-01-01T12:00:00.000Z',
  publishedAt: '2025-01-01T12:00:00.000Z',
};

describe('Fanvue post transport', () => {
  it('uses the documented v1 endpoint for free and priced posts', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(result), { status: 201 })),
      );
    const client = new FanvuePostClient(request);
    await expect(
      client.createPost('token', { audience: 'subscribers', text: 'Free update' }),
    ).resolves.toMatchObject({ uuid: postUuid });
    await expect(
      client.createPost('token', {
        audience: 'followers-and-subscribers',
        text: 'Paid update',
        mediaUuids: [mediaUuid],
        mediaPreviewUuid: mediaUuid,
        price: 300,
      }),
    ).resolves.toMatchObject({ uuid: postUuid });
    expect(request).toHaveBeenCalledTimes(2);
    for (const call of request.mock.calls) {
      expect(call[0]).toBe('https://api.fanvue.com/v1/posts');
      expect(call[1]?.method).toBe('POST');
      expect(call[1]?.headers).toMatchObject({
        Authorization: 'Bearer token',
        'X-Fanvue-API-Version': '2025-06-26',
      });
    }
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty('price');
    expect(JSON.parse(request.mock.calls[1]?.[1]?.body as string)).toMatchObject({
      price: 300,
      audience: 'followers-and-subscribers',
    });
  });

  it('rejects invalid paid content before any provider call', async () => {
    const request = vi.fn<typeof fetch>();
    const client = new FanvuePostClient(request);
    await expect(
      client.createPost('token', { audience: 'subscribers', price: 200, mediaUuids: [mediaUuid] }),
    ).rejects.toThrow();
    await expect(
      client.createPost('token', { audience: 'subscribers', price: 300, text: 'No media' }),
    ).rejects.toThrow();
    await expect(
      client.createPost('token', {
        audience: 'subscribers',
        text: 'No attachment',
        mediaPreviewUuid: mediaUuid,
      }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('classifies definite provider denial separately from ambiguous outcomes', async () => {
    const body = { audience: 'subscribers' as const, text: 'Hello' };
    const denied = new FanvuePostClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response('private', { status: 403 })),
    );
    await expect(denied.createPost('token', body)).rejects.toMatchObject({ status: 403 });
    const rateLimited = new FanvuePostClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response('private', { status: 429 })),
    );
    await expect(rateLimited.createPost('token', body)).rejects.toMatchObject({ status: 429 });
    const transient = new FanvuePostClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response('private', { status: 503 })),
    );
    await expect(transient.createPost('token', body)).rejects.toBeInstanceOf(
      FanvuePostOutcomeUnknownError,
    );
    const timeout = new FanvuePostClient(
      vi.fn<typeof fetch>().mockRejectedValue(new Error('lost response')),
    );
    await expect(timeout.createPost('token', body)).rejects.toBeInstanceOf(
      FanvuePostOutcomeUnknownError,
    );
  });
});
