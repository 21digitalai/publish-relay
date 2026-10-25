import { describe, expect, it } from 'vitest';

import { parseFanvuePaymentEvent } from '../src/modules/providers/fanvue-payment-event.js';

const creator = 'd6ed1cac-e0cd-4109-bf04-539cb8591838';
const fan = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const message = '2f7c5e8a-6d36-4e3a-98d9-9f1b3b0a1a10';
const eventId = 'f1a2b3c4-1111-4a2b-9c3d-aaaaaaaaaaaa';
const paidAt = '2026-06-09T08:39:33.139Z';

function payload(source: string, overrides: Record<string, unknown> = {}) {
  return Buffer.from(
    JSON.stringify({
      id: eventId,
      type: 'creator.payment.succeeded',
      timestamp: paidAt,
      data: {
        object: 'payment',
        id: 'FV-12345',
        status: 'succeeded',
        source,
        gross: 1999,
        currency: 'USD',
        paid_at: paidAt,
        post_uuid: null,
        message_uuid: message,
        tip_context: null,
        purchaser: { uuid: fan, email: 'sensitive@example.test', handle: 'fan' },
        creator: { uuid: creator },
        tracking: { link_url: 'private' },
        ...overrides,
      },
    }),
  );
}

describe('Fanvue signed payment facts', () => {
  it('projects a paid message without purchaser contact/tracking fields', () => {
    expect(parseFanvuePaymentEvent(payload('message'))).toEqual({
      eventId,
      creatorUuid: creator,
      fanUuid: fan,
      invoiceId: 'FV-12345',
      source: 'message',
      grossMinor: 1999,
      currency: 'USD',
      paidAt,
      eventAt: paidAt,
      postUuid: null,
      messageUuid: message,
      tipContext: null,
    });
  });

  it('preserves tip facts without inferring a specific message or offer', () => {
    expect(
      parseFanvuePaymentEvent(
        payload('tip', {
          message_uuid: null,
          tip_context: 'message',
          gross: 500,
        }),
      ),
    ).toMatchObject({
      source: 'tip',
      grossMinor: 500,
      messageUuid: null,
      tipContext: 'message',
    });
  });

  it('ignores other signed topics and rejects malformed payment data', () => {
    const other = JSON.parse(payload('message').toString('utf8')) as { type: string };
    other.type = 'creator.reward.created';
    expect(parseFanvuePaymentEvent(Buffer.from(JSON.stringify(other)))).toBeNull();
    expect(() => parseFanvuePaymentEvent(payload('tip', { gross: '500' }))).toThrow();
    expect(() => parseFanvuePaymentEvent(payload('tip', { purchaser: { email: 'x' } }))).toThrow();
  });
});
