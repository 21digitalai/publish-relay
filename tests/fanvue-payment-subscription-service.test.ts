import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  reserve: vi.fn(),
  cancel: vi.fn(),
  mark: vi.fn(),
  activate: vi.fn(),
  get: vi.fn(),
  disable: vi.fn(),
  token: vi.fn(),
}));
vi.mock('../src/modules/providers/fanvue-payment-subscription.repository.js', () => ({
  reserveFanvuePaymentSubscription: state.reserve,
  cancelFanvuePaymentReservation: state.cancel,
  markFanvueSubscriptionCreationUnknown: state.mark,
  activateFanvuePaymentSubscription: state.activate,
  getFanvuePaymentSubscriptionForAccount: state.get,
  disableFanvuePaymentSubscription: state.disable,
}));
vi.mock('../src/modules/providers/fanvue-credential.service.js', () => ({
  getFreshFanvueToken: state.token,
}));

import {
  createFanvuePaymentSubscription,
  deleteFanvuePaymentSubscription,
} from '../src/modules/providers/fanvue-payment-subscription.service.js';

const handle = 'A'.repeat(43);
const selected = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  creatorUuid: '00000000-0000-4000-8000-000000000003',
};
const providerId = '00000000-0000-4000-8000-000000000004';
const reservationId = '00000000-0000-4000-8000-000000000005';

function runtime() {
  const subscriptionClient = {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: providerId, signingSecret: 'fixture-secret' }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return {
    database: {} as never,
    keys: {} as never,
    oauthClient: {} as never,
    publicOrigin: 'https://relay.test',
    subscriptionClient: subscriptionClient as never,
    client: subscriptionClient,
  };
}

beforeEach(() => {
  for (const mock of Object.values(state)) mock.mockReset();
  state.reserve.mockResolvedValue({ id: reservationId, callbackHandle: handle });
  state.cancel.mockResolvedValue(undefined);
  state.mark.mockResolvedValue(undefined);
  state.activate.mockResolvedValue(undefined);
  state.disable.mockResolvedValue(undefined);
  state.token.mockResolvedValue({ access_token: 'creator-token' });
  state.get.mockResolvedValue({
    id: reservationId,
    creatorUuid: selected.creatorUuid,
    state: 'active',
    providerSubscriptionId: providerId,
  });
});

describe('Fanvue payment subscription command', () => {
  it('lists before outbound create, marks intent and persists confirmed ID and secret', async () => {
    const context = runtime();
    expect(await createFanvuePaymentSubscription(context, selected)).toBe('active');
    expect(context.client.list).toHaveBeenCalledExactlyOnceWith('creator-token');
    expect(state.mark).toHaveBeenCalledExactlyOnceWith(context.database, {
      workspaceId: selected.workspaceId,
      id: reservationId,
    });
    expect(context.client.create).toHaveBeenCalledExactlyOnceWith(
      'creator-token',
      `https://relay.test/webhooks/fanvue/payments/${handle}`,
    );
    expect(state.mark.mock.invocationCallOrder[0]).toBeLessThan(
      context.client.create.mock.invocationCallOrder[0] ?? 0,
    );
    expect(state.activate).toHaveBeenCalledWith(context.database, context.keys, {
      workspaceId: selected.workspaceId,
      id: reservationId,
      providerSubscriptionId: providerId,
      signingSecret: 'fixture-secret',
    });
    expect(state.cancel).not.toHaveBeenCalled();
  });

  it('cancels an unused reservation and never sends when a Relay callback already exists', async () => {
    const context = runtime();
    context.client.list.mockResolvedValueOnce([
      {
        id: providerId,
        url: `https://relay.test/webhooks/fanvue/payments/${handle}`,
      },
    ]);
    await expect(createFanvuePaymentSubscription(context, selected)).rejects.toThrow(
      'needs reconciliation',
    );
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(state.mark).not.toHaveBeenCalled();
    expect(context.client.create).not.toHaveBeenCalled();
  });

  it('rejects a non-HTTPS callback origin before reserving or calling Fanvue', async () => {
    const context = runtime();
    context.publicOrigin = 'http://relay.test';
    await expect(createFanvuePaymentSubscription(context, selected)).rejects.toThrow('HTTPS');
    expect(state.reserve).not.toHaveBeenCalled();
    expect(context.client.list).not.toHaveBeenCalled();
  });

  it('keeps a marked unknown create open and only disables after provider deletion', async () => {
    const context = runtime();
    context.client.create.mockRejectedValueOnce(new Error('lost provider response'));
    await expect(createFanvuePaymentSubscription(context, selected)).rejects.toThrow(
      'lost provider response',
    );
    expect(state.mark).toHaveBeenCalledOnce();
    expect(state.cancel).not.toHaveBeenCalled();
    await deleteFanvuePaymentSubscription(context, selected);
    expect(context.client.delete).toHaveBeenCalledExactlyOnceWith('creator-token', providerId);
    expect(state.disable).toHaveBeenCalledExactlyOnceWith(context.database, {
      workspaceId: selected.workspaceId,
      id: reservationId,
      providerSubscriptionId: providerId,
    });
    context.client.delete.mockRejectedValueOnce(new Error('delete unknown'));
    await expect(deleteFanvuePaymentSubscription(context, selected)).rejects.toThrow(
      'delete unknown',
    );
    expect(state.disable).toHaveBeenCalledTimes(1);
  });

  it('cancels a proven uncommitted mark failure but preserves an ambiguous commit', async () => {
    const context = runtime();
    state.mark.mockRejectedValueOnce(new Error('scope revoked'));
    state.get.mockResolvedValueOnce({ id: reservationId, state: 'probe_pending' });
    await expect(createFanvuePaymentSubscription(context, selected)).rejects.toThrow(
      'scope revoked',
    );
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(context.client.create).not.toHaveBeenCalled();

    state.cancel.mockClear();
    state.mark.mockRejectedValueOnce(new Error('commit acknowledgement lost'));
    state.get.mockResolvedValueOnce({ id: reservationId, state: 'creation_unknown' });
    await expect(createFanvuePaymentSubscription(context, selected)).rejects.toThrow(
      'commit acknowledgement lost',
    );
    expect(state.cancel).not.toHaveBeenCalled();
    expect(context.client.create).not.toHaveBeenCalled();
  });
});
