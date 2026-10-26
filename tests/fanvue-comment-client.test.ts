import { describe, expect, it, vi } from 'vitest';

import {
  FanvueCommentClient,
  FanvueCommentOutcomeUnknownError,
} from '../src/modules/providers/fanvue-comment-client.js';
import { FanvueRequestError } from '../src/modules/providers/fanvue-http-client.js';

const postUuid = '550e8400-e29b-41d4-a716-446655440001';
const commentUuid = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function fixture(
  status = 201,
  body: unknown = {
    uuid: commentUuid,
    text: 'Thanks',
    createdAt: '2025-01-15T10:30:00.000Z',
    updatedAt: null,
  },
) {
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  return { request, client: new FanvueCommentClient(request) };
}

describe('Fanvue top-level comment transport', () => {
  it('sends only text to a specified post and projects the stable result', async () => {
    const { request, client } = fixture();
    await expect(client.createComment('token', postUuid, 'Thanks')).resolves.toMatchObject({
      uuid: commentUuid,
      text: 'Thanks',
    });
    expect(request.mock.calls[0]?.[0]).toBe(`https://api.fanvue.com/v1/posts/${postUuid}/comments`);
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer token' });
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body as string)).toEqual({ text: 'Thanks' });
  });

  it('rejects invalid post ID and text before a provider call', async () => {
    const { request, client } = fixture();
    await expect(client.createComment('token', 'invalid', 'Thanks')).rejects.toThrow();
    await expect(client.createComment('token', postUuid, '')).rejects.toThrow();
    await expect(client.createComment('token', postUuid, 'x'.repeat(601))).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([400, 403, 429])('classifies definite HTTP %i failure', async (status) => {
    await expect(
      fixture(status, { secret: 'not returned' }).client.createComment('token', postUuid, 'Thanks'),
    ).rejects.toMatchObject({ status });
    await expect(
      fixture(status).client.createComment('token', postUuid, 'Thanks'),
    ).rejects.toBeInstanceOf(FanvueRequestError);
  });

  it('does not permit blind retry after ambiguous send outcome', async () => {
    const timeout = vi.fn<typeof fetch>().mockRejectedValue(new Error('timeout'));
    await expect(
      new FanvueCommentClient(timeout).createComment('token', postUuid, 'Thanks'),
    ).rejects.toBeInstanceOf(FanvueCommentOutcomeUnknownError);
    for (const [status, body] of [
      [503, {}],
      [201, {}],
    ] as const) {
      await expect(
        fixture(status, body).client.createComment('token', postUuid, 'Thanks'),
      ).rejects.toBeInstanceOf(FanvueCommentOutcomeUnknownError);
    }
  });
});
