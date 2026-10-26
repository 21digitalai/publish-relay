import { describe, expect, it, vi } from 'vitest';

import {
  FacebookHttpClient,
  FacebookRequestError,
} from '../src/modules/providers/facebook-http-client.js';

describe('Facebook Page Messenger send transport', () => {
  it('uses pinned Graph Page path, bearer token and a text RESPONSE', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          recipient_id: 'psid_7',
          message_id: 'mid_9',
        }),
        { status: 200 },
      ),
    );
    const client = new FacebookHttpClient({ graphVersion: 'v23.0', fetch });
    await expect(
      client.sendPageMessage({
        pageId: '123',
        recipientId: 'psid_7',
        text: 'Hello',
        accessToken: 'secret',
      }),
    ).resolves.toBe('mid_9');
    const [url, request] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://graph.facebook.com/v23.0/123/messages');
    expect(request.headers).toMatchObject({ authorization: 'Bearer secret' });
    expect(JSON.parse(request.body as string)).toEqual({
      recipient: { id: 'psid_7' },
      messaging_type: 'RESPONSE',
      message: { text: 'Hello' },
    });
  });

  it('treats an unparseable success and network failure as unknown outcomes', async () => {
    const client = new FacebookHttpClient({
      graphVersion: 'v23.0',
      fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    });
    await expect(
      client.sendPageMessage({
        pageId: '123',
        recipientId: 'psid_7',
        text: 'Hello',
        accessToken: 'secret',
      }),
    ).rejects.toMatchObject({ outcomeUnknown: true });
    const failing = new FacebookHttpClient({
      graphVersion: 'v23.0',
      fetch: vi.fn().mockRejectedValue(new Error('disconnect')),
    });
    await expect(
      failing.sendPageMessage({
        pageId: '123',
        recipientId: 'psid_7',
        text: 'Hello',
        accessToken: 'secret',
      }),
    ).rejects.toBeInstanceOf(FacebookRequestError);
  });
});
