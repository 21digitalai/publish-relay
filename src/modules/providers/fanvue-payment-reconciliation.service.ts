import { createHash } from 'node:crypto';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { FanvuePaymentSubscriptionClient } from './fanvue-payment-subscription-client.js';
import {
  getFanvuePaymentSubscriptionForAccount,
  reconcileDeletedFanvuePaymentSubscription,
} from './fanvue-payment-subscription.repository.js';

interface ProviderDestination {
  id: string;
  url: string;
}

function parseCallbackOrigin(publicOrigin: string): URL {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('Fanvue callback origin must be an HTTPS origin');
  return origin;
}

function callbackHandle(destinationUrl: string, origin: URL): string | null {
  const url = new URL(destinationUrl);
  const prefix = '/webhooks/fanvue/payments/';
  if (url.origin !== origin.origin || url.search || url.hash || !url.pathname.startsWith(prefix))
    return null;
  const handle = url.pathname.slice(prefix.length);
  return /^[A-Za-z0-9_-]{43}$/.test(handle) ? handle : null;
}

export function hasFanvuePaymentCallbackAtOrigin(
  destinations: readonly ProviderDestination[],
  publicOrigin: string,
): boolean {
  const origin = parseCallbackOrigin(publicOrigin);
  return destinations.some((destination) => callbackHandle(destination.url, origin) !== null);
}

/** Match only this Relay origin and the exact one-use callback, never another creator's URL. */
export function findFanvuePaymentCallbackDestinations(
  destinations: readonly ProviderDestination[],
  publicOrigin: string,
  callbackHandleHash: string,
): ProviderDestination[] {
  const origin = parseCallbackOrigin(publicOrigin);
  return destinations.filter((destination) => {
    const handle = callbackHandle(destination.url, origin);
    return (
      handle !== null && createHash('sha256').update(handle).digest('hex') === callbackHandleHash
    );
  });
}

/** A missing list entry cannot settle an in-flight POST; only confirmed deletion releases it. */
export async function reconcileFanvuePaymentCreation(
  database: NodePgDatabase,
  client: FanvuePaymentSubscriptionClient,
  input: {
    workspaceId: string;
    accountId: string;
    accessToken: string;
    publicOrigin: string;
  },
): Promise<'no_open_attempt' | 'pending' | 'reconciled'> {
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
  if (matches.length === 0) return 'pending';
  for (const match of matches) await client.delete(input.accessToken, match.id);
  const remaining = findFanvuePaymentCallbackDestinations(
    await client.list(input.accessToken),
    input.publicOrigin,
    row.callbackHandleHash,
  );
  if (remaining.length) throw new Error('Fanvue payment subscription remains at provider');
  await reconcileDeletedFanvuePaymentSubscription(database, {
    workspaceId: input.workspaceId,
    id: row.id,
    providerDeletionConfirmed: true,
  });
  return 'reconciled';
}
