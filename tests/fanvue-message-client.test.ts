import { describe, expect, it, vi } from 'vitest';

import {
  FanvueMessageClient,
  FanvueMessageOutcomeUnknownError,
} from '../src/modules/providers/fanvue-message-client.js';
import { FanvueRequestError } from '../src/modules/providers/fanvue-http-client.js';

const fanUuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const mediaUuid = '0b4a3c1e-2f6d-4b8a-9c1d-5e7f8a9b0c1d';
const messageUuid = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function fixture(status = 201, body: unknown = { messageUuid }) {
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  return { request, client: new FanvueMessageClient(request) };
}

describe('Fanvue one-to-one message transport', () => {
  it('creates only the selected fan chat, with no message payload', async () => {
    const { request, client } = fixture(201, { message: 'Chat created successfully' });
    await expect(client.createChat('token', fanUuid)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('https://api.fanvue.com/chats');
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body as string)).toEqual({ userUuid: fanUuid });
    expect(request.mock.calls[0]?.[1]?.method).toBe('POST');
  });

  it('classifies contactability denial and uncertain create without retrying', async () => {
    await expect(fixture(400).client.createChat('token', fanUuid)).rejects.toMatchObject({
      status: 400,
    });
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('timeout'));
    await expect(
      new FanvueMessageClient(request).createChat('token', fanUuid),
    ).rejects.toBeInstanceOf(FanvueMessageOutcomeUnknownError);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('sends free text and priced media with an attached preview', async () => {
    const { request, client } = fixture();
    await expect(client.sendMessage('token', fanUuid, { text: 'Hello' })).resolves.toEqual({
      messageUuid,
    });
    await expect(
      client.sendMessage('token', fanUuid, {
        text: 'Preview',
        mediaUuids: [mediaUuid],
        mediaPreviewUuid: mediaUuid,
        price: 300,
      }),
    ).resolves.toEqual({ messageUuid });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toBe(`https://api.fanvue.com/chats/${fanUuid}/message`);
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer token' });
    expect(JSON.parse(request.mock.calls[1]?.[1]?.body as string)).toEqual({
      text: 'Preview',
      mediaUuids: [mediaUuid],
      mediaPreviewUuid: mediaUuid,
      price: 300,
    });
  });

  it('rejects unsupported shapes before a provider call', async () => {
    const { request, client } = fixture();
    for (const input of [
      {},
      { price: 300, text: 'No media' },
      { mediaUuids: [mediaUuid], price: 299 },
      { mediaUuids: [mediaUuid], mediaPreviewUuid: mediaUuid },
      { mediaUuids: [mediaUuid], price: 300, mediaPreviewUuid: fanUuid },
    ])
      await expect(client.sendMessage('token', fanUuid, input)).rejects.toThrow();
    await expect(client.sendMessage('token', 'bad-id', { text: 'Hello' })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([400, 403, 429])(
    'classifies provider HTTP %i without disclosing body',
    async (status) => {
      const { client } = fixture(status, { private: 'do not expose' });
      await expect(client.sendMessage('token', fanUuid, { text: 'Hello' })).rejects.toMatchObject({
        status,
      });
      await expect(client.sendMessage('token', fanUuid, { text: 'Hello' })).rejects.toBeInstanceOf(
        FanvueRequestError,
      );
    },
  );

  it('treats timeout, server failure and malformed success as unknown outcomes', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('timeout'));
    await expect(
      new FanvueMessageClient(request).sendMessage('token', fanUuid, { text: 'Hi' }),
    ).rejects.toBeInstanceOf(FanvueMessageOutcomeUnknownError);
    for (const [status, body] of [
      [503, {}],
      [201, {}],
    ] as const) {
      await expect(
        fixture(status, body).client.sendMessage('token', fanUuid, { text: 'Hi' }),
      ).rejects.toBeInstanceOf(FanvueMessageOutcomeUnknownError);
    }
  });
});
