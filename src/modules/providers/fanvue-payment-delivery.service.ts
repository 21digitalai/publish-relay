import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { parseFanvuePaymentEvent } from './fanvue-payment-event.js';
import { receiptFanvuePaymentForAccount } from './fanvue-payment-receipt.repository.js';
import { verifyFanvueWebhookSignature } from './fanvue-webhook-signature.js';

export interface FanvuePaymentSubscription {
  workspaceId: string;
  accountId: string;
  creatorUuid: string;
  signingSecrets: readonly string[];
}

export class FanvuePaymentDeliveryRejectedError extends Error {
  constructor(public readonly reason: 'signature_invalid' | 'creator_mismatch') {
    super(`Fanvue payment delivery rejected: ${reason}`);
  }
}

/** The callback resolver supplies only the selected account and its encrypted-at-rest secret. */
export async function recordFanvuePaymentDelivery(
  database: NodePgDatabase,
  input: {
    subscription: FanvuePaymentSubscription;
    rawBody: Buffer;
    signatureHeader: string | undefined;
    now?: Date;
  },
): Promise<'recorded' | 'duplicate' | 'ignored'> {
  if (
    !verifyFanvueWebhookSignature({
      rawBody: input.rawBody,
      signatureHeader: input.signatureHeader,
      signingSecrets: input.subscription.signingSecrets,
      ...(input.now ? { now: input.now } : {}),
    })
  )
    throw new FanvuePaymentDeliveryRejectedError('signature_invalid');

  const signal = parseFanvuePaymentEvent(input.rawBody);
  if (!signal) return 'ignored';
  if (signal.creatorUuid !== input.subscription.creatorUuid)
    throw new FanvuePaymentDeliveryRejectedError('creator_mismatch');
  return receiptFanvuePaymentForAccount(database, {
    workspaceId: input.subscription.workspaceId,
    accountId: input.subscription.accountId,
    signal,
  });
}
