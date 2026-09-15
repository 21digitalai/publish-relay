import { describe, expect, it, vi } from 'vitest';

import { ResendEmailDelivery } from '../src/modules/identity/resend-email.delivery.js';

describe('ResendEmailDelivery', () => {
  it('sends a bounded idempotent sign-in email and returns only the provider identifier', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
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
    const body = init?.body;
    if (typeof body !== 'string') throw new Error('Expected a JSON email request body');
    expect(JSON.parse(body)).toEqual(
      expect.objectContaining({
        from: 'login@relay.example',
        to: ['owner@example.test'],
        subject: 'Sign in to Publish Relay',
      }),
    );
  });

  it('fails closed without exposing provider response bodies', async () => {
    const request = vi
      .fn<typeof fetch>()
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
          init?.signal?.addEventListener(
            'abort',
            () => {
              const reason: unknown = init.signal?.reason;
              reject(reason instanceof Error ? reason : new Error('Request aborted'));
            },
            { once: true },
          );
        }),
    );
    const delivery = new ResendEmailDelivery(
      { apiKey: 'secret-key', from: 'login@relay.example', timeoutMs: 1 },
      request,
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
