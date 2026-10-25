import { describe, expect, it, vi } from 'vitest';

import { FanvueRequestError } from '../src/modules/providers/fanvue-http-client.js';
import {
  FanvuePaymentSubscriptionClient,
  FanvueSubscriptionOutcomeUnknownError,
} from '../src/modules/providers/fanvue-payment-subscription-client.js';

const subscriptionId = 'b6f0e6d2-1f0a-4f1e-9b3a-1c2d3e4f5a6b';
const signingSecret = `whsec_${'a'.repeat(64)}`;

describe('Fanvue payment subscription transport', () => {
  it('creates only the approved payment topic and returns the one-time secret', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: subscriptionId, signingSecret }, { status: 201 }));
    const client = new FanvuePaymentSubscriptionClient(request);
    expect(
      await client.create('token', 'https://relay.test/webhooks/fanvue/payments/opaque'),
    ).toEqual({
      id: subscriptionId,
      signingSecret,
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe('https://api.fanvue.com/webhooks/subscriptions');
    const options = request.mock.calls[0]?.[1];
    expect(options?.method).toBe('POST');
    expect(options?.body).toBe(
      JSON.stringify({
        url: 'https://relay.test/webhooks/fanvue/payments/opaque',
        events: ['creator.payment.succeeded'],
      }),
    );
  });

  it('rejects invalid URL before provider access and classifies definite vs unknown create results', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    const client = new FanvuePaymentSubscriptionClient(request);
    await expect(client.create('token', 'http://localhost/hook')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await expect(client.create('token', 'https://relay.test/hook')).rejects.toBeInstanceOf(
      FanvueRequestError,
    );
    request.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(client.create('token', 'https://relay.test/hook')).rejects.toBeInstanceOf(
      FanvueSubscriptionOutcomeUnknownError,
    );
    request.mockResolvedValueOnce(Response.json({ id: subscriptionId }, { status: 201 }));
    await expect(client.create('token', 'https://relay.test/hook')).rejects.toBeInstanceOf(
      FanvueSubscriptionOutcomeUnknownError,
    );
  });

  it('treats confirmed deletion or provider 404 as absent, not transport failure', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    const client = new FanvuePaymentSubscriptionClient(request);
    await client.delete('token', subscriptionId);
    expect(request.mock.calls[0]?.[0]).toBe(
      `https://api.fanvue.com/webhooks/subscriptions/${subscriptionId}`,
    );
    request.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.delete('token', subscriptionId);
    request.mockResolvedValueOnce(new Response(null, { status: 429 }));
    await expect(client.delete('token', subscriptionId)).rejects.toBeInstanceOf(FanvueRequestError);
    request.mockRejectedValueOnce(new Error('timeout'));
    await expect(client.delete('token', subscriptionId)).rejects.toBeInstanceOf(
      FanvueSubscriptionOutcomeUnknownError,
    );
  });
});
