import { createHash } from 'node:crypto';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { FanvuePaymentSubscriptionClient } from './fanvue-payment-subscription-client.js';
import {
  getFanvuePaymentSubscriptionForAccount,
  reconcileAbsentFanvuePaymentSubscription,
} from './fanvue-payment-subscription.repository.js';

interface ProviderDestination {
  id: string;
  url: string;
}

/** Match only this Relay origin and the exact one-use callback, never another creator's URL. */
export function findFanvuePaymentCallbackDestinations(
  destinations: readonly ProviderDestination[],
  publicOrigin: string,
  callbackHandleHash: string,
): ProviderDestination[] {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('Fanvue callback origin must be an HTTPS origin');
  const prefix = '/webhooks/fanvue/payments/';
  return destinations.filter((destination) => {
    const url = new URL(destination.url);
    if (url.origin !== origin.origin || url.search || url.hash || !url.pathname.startsWith(prefix))
      return false;
    const handle = url.pathname.slice(prefix.length);
    if (!/^[A-Za-z0-9_-]{43}$/.test(handle)) return false;
    return createHash('sha256').update(handle).digest('hex') === callbackHandleHash;
  });
}

/** Reconcile an uncertain create by provider listing and exact-ID deletion before releasing the row. */
export async function reconcileFanvuePaymentCreation(
  database: NodePgDatabase,
  client: FanvuePaymentSubscriptionClient,
  input: {
    workspaceId: string;
    accountId: string;
    accessToken: string;
    publicOrigin: string;
  },
): Promise<'no_open_attempt' | 'reconciled'> {
  const row = await getFanvuePaymentSubscriptionForAccount(database, input);
  if (!row) return 'no_open_attempt';
  if (row.state !== 'creation_unknown' || row.providerSubscriptionId)
    throw new Error('Fanvue payment subscription cannot be reconciled as absent');

  const destinations = await client.list(input.accessToken);
  const matches = findFanvuePaymentCallbackDestinations(
    destinations,
    input.publicOrigin,
    row.callbackHandleHash,
  );
  for (const match of matches) await client.delete(input.accessToken, match.id);
  const remaining = findFanvuePaymentCallbackDestinations(
    await client.list(input.accessToken),
    input.publicOrigin,
    row.callbackHandleHash,
  );
  if (remaining.length) throw new Error('Fanvue payment subscription remains at provider');
  await reconcileAbsentFanvuePaymentSubscription(database, {
    workspaceId: input.workspaceId,
    id: row.id,
    providerAbsenceConfirmed: true,
  });
  return 'reconciled';
}
