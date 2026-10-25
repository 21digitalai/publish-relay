import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerRedactedNotFoundHandler,
  requestLoggerOptions,
} from '../src/application/request-logger.js';

const callbacks = vi.hoisted(() => ({ resolve: vi.fn(), record: vi.fn() }));
vi.mock('../src/modules/providers/fanvue-payment-callback.repository.js', () => ({
  resolveFanvuePaymentCallback: callbacks.resolve,
}));
vi.mock('../src/modules/providers/fanvue-payment-delivery.service.js', async (original) => ({
  ...(await original()),
  recordFanvuePaymentDelivery: callbacks.record,
}));

import { registerFanvuePaymentWebhook } from '../src/modules/providers/fanvue-payment-webhook.routes.js';

const handle = 'A'.repeat(43);
const url = `/webhooks/fanvue/payments/${handle}`;
const probe = JSON.stringify({
  type: 'fanvue.webhook.verification',
  timestamp: '2026-10-25T13:00:00Z',
});

beforeEach(() => {
  callbacks.resolve.mockReset().mockResolvedValue({ state: 'probe_pending' });
  callbacks.record.mockReset().mockResolvedValue('recorded');
});

describe('Fanvue payment webhook HTTP boundary', () => {
  it('accepts only the exact unsigned probe for a reserved opaque handle', async () => {
    const app = Fastify();
    registerFanvuePaymentWebhook(app, { database: {} as never, keys: {} as never });
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: probe,
          headers: { 'content-type': 'application/json' },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: '{}',
          headers: { 'content-type': 'application/json' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: probe,
          headers: { 'content-type': 'application/json', 'x-fanvue-signature': 'invalid' },
        })
      ).statusCode,
    ).toBe(401);
    expect(callbacks.record).not.toHaveBeenCalled();
    await app.close();
  });

  it('passes raw signed bytes to the selected-account delivery service before 204', async () => {
    const app = Fastify();
    const subscription = {
      workspaceId: '00000000-0000-4000-8000-000000000001',
      accountId: '00000000-0000-4000-8000-000000000002',
      creatorUuid: '00000000-0000-4000-8000-000000000003',
      signingSecrets: ['fixture'],
    };
    callbacks.resolve.mockResolvedValue({ state: 'active', subscription });
    registerFanvuePaymentWebhook(app, { database: {} as never, keys: {} as never });
    const raw = '{ "id": "fixture", "type": "creator.payment.succeeded" }';
    const response = await app.inject({
      method: 'POST',
      url,
      payload: raw,
      headers: { 'content-type': 'application/json', 'x-fanvue-signature': 'signed' },
    });
    expect(response.statusCode).toBe(204);
    const input = callbacks.record.mock.calls[0]?.[1] as { rawBody: Buffer; subscription: unknown };
    expect(input.rawBody.equals(Buffer.from(raw))).toBe(true);
    expect(input.subscription).toBe(subscription);
    await app.close();
  });

  it('does not acknowledge a delivery when durable receipt fails', async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: { ...requestLoggerOptions, stream: { write: (line) => lines.push(line) } },
    });
    callbacks.resolve.mockResolvedValue({ state: 'active', subscription: {} });
    callbacks.record.mockRejectedValue(new Error('database unavailable'));
    registerFanvuePaymentWebhook(app, { database: {} as never, keys: {} as never });
    registerRedactedNotFoundHandler(app);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: '{}',
          headers: { 'content-type': 'application/json' },
        })
      ).statusCode,
    ).toBe(500);
    const missing = await app.inject({ method: 'GET', url: `${url}/wrong-route` });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain(handle);
    expect(lines.join('')).not.toContain(handle);
    expect(callbacks.resolve).toHaveBeenCalledWith(expect.anything(), expect.anything(), handle);
    await app.close();
  });
});
