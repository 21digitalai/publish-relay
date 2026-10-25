import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const repository = vi.hoisted(() => ({ get: vi.fn(), absent: vi.fn() }));
vi.mock('../src/modules/providers/fanvue-payment-subscription.repository.js', () => ({
  getFanvuePaymentSubscriptionForAccount: repository.get,
  reconcileAbsentFanvuePaymentSubscription: repository.absent,
}));

import {
  findFanvuePaymentCallbackDestinations,
  reconcileFanvuePaymentCreation,
} from '../src/modules/providers/fanvue-payment-reconciliation.service.js';

const handle = 'A'.repeat(43);
const hash = createHash('sha256').update(handle).digest('hex');
const url = `https://relay.test/webhooks/fanvue/payments/${handle}`;
const match = { id: '00000000-0000-4000-8000-000000000001', url };

beforeEach(() => {
  repository.get.mockReset().mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000002',
    callbackHandleHash: hash,
    state: 'creation_unknown',
    providerSubscriptionId: null,
  });
  repository.absent.mockReset().mockResolvedValue(undefined);
});

describe('Fanvue payment creation reconciliation', () => {
  it('matches only the exact one-use handle on the intended HTTPS origin', () => {
    expect(
      findFanvuePaymentCallbackDestinations(
        [
          match,
          { ...match, url: `https://other.test/webhooks/fanvue/payments/${handle}` },
          { ...match, url: `${url}/extra` },
          { ...match, url: `${url}?leak=1` },
          { ...match, url: url.replace(handle, 'B'.repeat(43)) },
        ],
        'https://relay.test',
        hash,
      ),
    ).toEqual([match]);
    expect(() => findFanvuePaymentCallbackDestinations([], 'http://relay.test', hash)).toThrow();
  });

  it('deletes only exact provider matches and releases the row after a second absence check', async () => {
    const client = {
      list: vi.fn().mockResolvedValueOnce([match]).mockResolvedValueOnce([]),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const input = {
      workspaceId: '00000000-0000-4000-8000-000000000003',
      accountId: '00000000-0000-4000-8000-000000000004',
      accessToken: 'fixture',
      publicOrigin: 'https://relay.test',
    };
    expect(await reconcileFanvuePaymentCreation({} as never, client as never, input)).toBe(
      'reconciled',
    );
    expect(client.delete).toHaveBeenCalledExactlyOnceWith('fixture', match.id);
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(repository.absent).toHaveBeenCalledOnce();
  });

  it('keeps the uncertain row open if the provider still lists it or deletion fails', async () => {
    const input = {
      workspaceId: '00000000-0000-4000-8000-000000000003',
      accountId: '00000000-0000-4000-8000-000000000004',
      accessToken: 'fixture',
      publicOrigin: 'https://relay.test',
    };
    const stillListed = {
      list: vi.fn().mockResolvedValue([match]),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    await expect(
      reconcileFanvuePaymentCreation({} as never, stillListed as never, input),
    ).rejects.toThrow('remains');
    expect(repository.absent).not.toHaveBeenCalled();

    const deleteFails = {
      list: vi.fn().mockResolvedValue([match]),
      delete: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    };
    await expect(
      reconcileFanvuePaymentCreation({} as never, deleteFails as never, input),
    ).rejects.toThrow('provider unavailable');
    expect(repository.absent).not.toHaveBeenCalled();
  });
});
