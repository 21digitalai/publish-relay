import { z } from 'zod';

const payment = z.object({
  object: z.literal('payment'),
  id: z.string().min(1).max(200),
  status: z.literal('succeeded'),
  source: z.enum(['post', 'message', 'media', 'tip', 'subscription']),
  gross: z.number().int().nonnegative(),
  currency: z.string().length(3).nullable(),
  paid_at: z.iso.datetime().nullable(),
  post_uuid: z.uuid().nullable(),
  message_uuid: z.uuid().nullable(),
  tip_context: z.enum(['post', 'message']).nullable(),
  purchaser: z.object({ uuid: z.uuid() }),
  creator: z.object({ uuid: z.uuid() }),
});
const envelope = z.object({
  id: z.uuid(),
  type: z.string(),
  timestamp: z.iso.datetime(),
  data: z.unknown(),
});

export interface FanvuePaymentSignal {
  eventId: string;
  creatorUuid: string;
  fanUuid: string;
  invoiceId: string;
  source: 'post' | 'message' | 'media' | 'tip' | 'subscription';
  grossMinor: number;
  currency: string | null;
  paidAt: string | null;
  eventAt: string;
  postUuid: string | null;
  messageUuid: string | null;
  tipContext: 'post' | 'message' | null;
}

/** Project only signed provider facts; tips do not imply an offer or chat purchase. */
export function parseFanvuePaymentEvent(rawBody: Buffer): FanvuePaymentSignal | null {
  const parsedEnvelope = envelope.parse(JSON.parse(rawBody.toString('utf8')) as unknown);
  if (parsedEnvelope.type !== 'creator.payment.succeeded') return null;
  const data = payment.parse(parsedEnvelope.data);
  return {
    eventId: parsedEnvelope.id,
    creatorUuid: data.creator.uuid,
    fanUuid: data.purchaser.uuid,
    invoiceId: data.id,
    source: data.source,
    grossMinor: data.gross,
    currency: data.currency,
    paidAt: data.paid_at,
    eventAt: parsedEnvelope.timestamp,
    postUuid: data.post_uuid,
    messageUuid: data.message_uuid,
    tipContext: data.tip_context,
  };
}
