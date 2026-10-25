import { createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const receipts = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('../src/modules/providers/fanvue-payment-receipt.repository.js', () => ({
  receiptFanvuePaymentForAccount: receipts.record,
}));

import {
  FanvuePaymentDeliveryRejectedError,
  recordFanvuePaymentDelivery,
} from '../src/modules/providers/fanvue-payment-delivery.service.js';

const creatorUuid = '00000000-0000-4000-8000-000000000001';
const subscription = {
  workspaceId: '00000000-0000-4000-8000-000000000002',
  accountId: '00000000-0000-4000-8000-000000000003',
  creatorUuid,
  signingSecrets: ['fixture-secret'],
};
const now = new Date('2026-10-25T13:00:00Z');
const payment = {
  id: '00000000-0000-4000-8000-000000000004',
  type: 'creator.payment.succeeded',
  timestamp: now.toISOString(),
  data: {
    object: 'payment',
    id: 'invoice-1',
    status: 'succeeded',
    source: 'tip',
    gross: 500,
    currency: 'USD',
    paid_at: now.toISOString(),
    post_uuid: null,
    message_uuid: null,
    tip_context: 'message',
    purchaser: { uuid: '00000000-0000-4000-8000-000000000005' },
    creator: { uuid: creatorUuid },
  },
};

function signed(rawBody: Buffer, timestamp = Math.floor(now.getTime() / 1000)): string {
  const mac = createHmac('sha256', subscription.signingSecrets[0] ?? '')
    .update(Buffer.concat([Buffer.from(`${String(timestamp)}.`), rawBody]))
    .digest('hex');
  return `t=${String(timestamp)},v0=${mac}`;
}

beforeEach(() => {
  receipts.record.mockReset().mockResolvedValue('recorded');
});

describe('Fanvue signed payment delivery', () => {
  it('persists exact selected-account payment facts and returns the durable receipt result', async () => {
    const rawBody = Buffer.from(JSON.stringify(payment));
    const input = { subscription, rawBody, signatureHeader: signed(rawBody), now };
    await expect(recordFanvuePaymentDelivery({} as never, input)).resolves.toBe('recorded');
    const persisted = receipts.record.mock.calls[0]?.[1] as unknown;
    expect(persisted).toMatchObject({
      workspaceId: subscription.workspaceId,
      accountId: subscription.accountId,
      signal: {
        creatorUuid,
        fanUuid: payment.data.purchaser.uuid,
        source: 'tip',
        messageUuid: null,
      },
    });
    receipts.record.mockResolvedValueOnce('duplicate');
    await expect(recordFanvuePaymentDelivery({} as never, input)).resolves.toBe('duplicate');
  });

  it('rejects unsigned, tampered and stale deliveries before persistence', async () => {
    const rawBody = Buffer.from(JSON.stringify(payment));
    const base = { subscription, rawBody, now };
    for (const signatureHeader of [
      undefined,
      signed(Buffer.from('different bytes')),
      signed(rawBody, Math.floor(now.getTime() / 1000) - 301),
    ]) {
      await expect(
        recordFanvuePaymentDelivery({} as never, { ...base, signatureHeader }),
      ).rejects.toMatchObject({ reason: 'signature_invalid' });
    }
    expect(receipts.record).not.toHaveBeenCalled();
  });

  it('rejects a correctly signed event for another creator', async () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        ...payment,
        data: { ...payment.data, creator: { uuid: subscription.accountId } },
      }),
    );
    await expect(
      recordFanvuePaymentDelivery({} as never, {
        subscription,
        rawBody,
        signatureHeader: signed(rawBody),
        now,
      }),
    ).rejects.toBeInstanceOf(FanvuePaymentDeliveryRejectedError);
    expect(receipts.record).not.toHaveBeenCalled();
  });

  it('ignores other signed event types without persisting a payment', async () => {
    const rawBody = Buffer.from(JSON.stringify({ ...payment, type: 'creator.post.created' }));
    await expect(
      recordFanvuePaymentDelivery({} as never, {
        subscription,
        rawBody,
        signatureHeader: signed(rawBody),
        now,
      }),
    ).resolves.toBe('ignored');
    expect(receipts.record).not.toHaveBeenCalled();
  });
});
