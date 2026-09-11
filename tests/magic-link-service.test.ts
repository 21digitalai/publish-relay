import { describe, expect, it, vi } from 'vitest';

import {
  MagicLinkService,
  type EmailDelivery,
  type MagicLinkStore,
} from '../src/modules/identity/magic-link.service.js';

function createStore(): MagicLinkStore {
  return {
    findEnabledUserIdByEmail: vi.fn().mockResolvedValue('user-1'),
    consumeRateLimit: vi.fn().mockResolvedValue(true),
    createChallenge: vi.fn().mockResolvedValue('challenge-1'),
    markDelivery: vi.fn(),
  };
}

function createDelivery(): EmailDelivery {
  return { sendMagicLink: vi.fn().mockResolvedValue({ messageId: 'message-1' }) };
}

function createService(store: MagicLinkStore, delivery: EmailDelivery, development = false) {
  return new MagicLinkService(store, delivery, {
    pepper: 'test-pepper',
    publicOrigin: 'https://relay.example',
    exposeDevelopmentUrl: development,
  });
}

const request = {
  email: ' Owner@Example.Test ',
  networkKey: 'network',
  userAgent: 'browser',
  correlationId: 'request-1',
  now: new Date(0),
};

describe('MagicLinkService', () => {
  it('persists hashed challenge material and sends the raw URL only through delivery', async () => {
    const store = createStore();
    const delivery = createDelivery();
    const result = await createService(store, delivery).requestLogin(request);

    expect(result).toEqual({ accepted: true });
    expect(store.createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        purpose: 'login',
        redirectPath: '/app',
        expiresAt: new Date(15 * 60 * 1_000),
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    const challenge = vi.mocked(store.createChallenge).mock.calls[0]?.[0];
    const delivered = vi.mocked(delivery.sendMagicLink).mock.calls[0]?.[0];
    expect(JSON.stringify(challenge)).not.toContain(delivered?.url.split('token=')[1]);
    expect(delivered).toMatchObject({ recipient: 'owner@example.test' });
    expect(store.markDelivery).toHaveBeenCalledWith('challenge-1', 'sent', 'message-1');
  });

  it.each([
    ['unknown account', null, true],
    ['rate limited account', 'user-1', false],
  ])('returns the same neutral response for %s', async (_label, userId, isAllowed) => {
    const store = createStore();
    vi.mocked(store.findEnabledUserIdByEmail).mockResolvedValue(userId);
    vi.mocked(store.consumeRateLimit).mockResolvedValue(isAllowed);
    const delivery = createDelivery();

    expect(await createService(store, delivery).requestLogin(request)).toEqual({ accepted: true });
    expect(store.createChallenge).not.toHaveBeenCalled();
    expect(delivery.sendMagicLink).not.toHaveBeenCalled();
  });

  it('returns a one-time URL only in explicit development mode without email delivery', async () => {
    const store = createStore();
    const delivery = createDelivery();
    const result = await createService(store, delivery, true).requestLogin(request);
    expect(result.developmentUrl).toMatch(
      /^https:\/\/relay\.example\/api\/auth\/magic-link\/verify\?token=/,
    );
    expect(delivery.sendMagicLink).not.toHaveBeenCalled();
    expect(store.markDelivery).toHaveBeenCalledWith('challenge-1', 'sent');
  });

  it('records delivery failure without issuing a successful response', async () => {
    const store = createStore();
    const delivery = createDelivery();
    vi.mocked(delivery.sendMagicLink).mockRejectedValue(new Error('delivery unavailable'));
    await expect(createService(store, delivery).requestLogin(request)).rejects.toThrow(
      'delivery unavailable',
    );
    expect(store.markDelivery).toHaveBeenCalledWith('challenge-1', 'failed');
  });
});
