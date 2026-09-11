import { describe, expect, it, vi } from 'vitest';

import { ResendEmailDelivery } from '../src/modules/identity/resend-email.delivery.js';

describe('ResendEmailDelivery', () => {
  it('sends a bounded idempotent sign-in email and returns only the provider identifier', async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'email-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const delivery = new ResendEmailDelivery(
      { apiKey: 'secret-key', from: 'login@relay.example' },
      request,
    );

    await expect(
      delivery.sendMagicLink({
        recipient: 'owner@example.test',
        url: 'https://relay.example/api/auth/magic-link/verify?token=one-time',
        correlationId: 'request-1',
      }),
    ).resolves.toEqual({ messageId: 'email-1' });
    const [, init] = vi.mocked(request).mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer secret-key',
      'idempotency-key': 'request-1',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual(
      expect.objectContaining({
        from: 'login@relay.example',
        to: ['owner@example.test'],
        subject: 'Sign in to Publish Relay',
      }),
    );
  });

  it('fails closed without exposing provider response bodies', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response('sensitive provider detail', { status: 429 }));
    const delivery = new ResendEmailDelivery(
      { apiKey: 'secret-key', from: 'login@relay.example' },
      request,
    );
    await expect(
      delivery.sendMagicLink({
        recipient: 'owner@example.test',
        url: 'https://relay.example/link',
        correlationId: 'request-2',
      }),
    ).rejects.toThrow('Resend delivery failed with status 429');
  });

  it('aborts a provider request that exceeds the bounded delivery timeout', async () => {
    const request = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const delivery = new ResendEmailDelivery(
      { apiKey: 'secret-key', from: 'login@relay.example', timeoutMs: 1 },
      request as typeof fetch,
    );
    await expect(
      delivery.sendMagicLink({
        recipient: 'owner@example.test',
        url: 'https://relay.example/link',
        correlationId: 'request-timeout',
      }),
    ).rejects.toThrow();
  });
});
