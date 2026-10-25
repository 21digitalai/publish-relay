import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import { getFreshFanvueToken } from './fanvue-credential.service.js';
import type { FanvueHttpClient } from './fanvue-http-client.js';
import { hasFanvuePaymentCallbackAtOrigin } from './fanvue-payment-reconciliation.service.js';
import type { FanvuePaymentSubscriptionClient } from './fanvue-payment-subscription-client.js';
import {
  activateFanvuePaymentSubscription,
  cancelFanvuePaymentReservation,
  disableFanvuePaymentSubscription,
  getFanvuePaymentSubscriptionForAccount,
  markFanvueSubscriptionCreationUnknown,
  reserveFanvuePaymentSubscription,
} from './fanvue-payment-subscription.repository.js';

export interface FanvuePaymentSubscriptionRuntime {
  database: NodePgDatabase;
  keys: MasterKeyProvider;
  oauthClient: FanvueHttpClient;
  subscriptionClient: FanvuePaymentSubscriptionClient;
  publicOrigin: string;
}

interface SelectedCreator {
  workspaceId: string;
  accountId: string;
  creatorUuid: string;
}

/** Internal command only. A future owner action must authorize live subscription creation. */
export async function createFanvuePaymentSubscription(
  runtime: FanvuePaymentSubscriptionRuntime,
  selected: SelectedCreator,
): Promise<'active' | 'deletion_required'> {
  const origin = new URL(runtime.publicOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('Fanvue callback origin must be an HTTPS origin');
  const reservation = await reserveFanvuePaymentSubscription(runtime.database, selected);
  let accessToken: string;
  try {
    const token = await getFreshFanvueToken(runtime.database, runtime.keys, runtime.oauthClient, {
      workspaceId: selected.workspaceId,
      creatorId: selected.creatorUuid,
    });
    accessToken = token.access_token;
    const destinations = await runtime.subscriptionClient.list(accessToken);
    if (hasFanvuePaymentCallbackAtOrigin(destinations, runtime.publicOrigin))
      throw new Error('Existing Fanvue payment callback needs reconciliation before create');
  } catch (error) {
    await cancelFanvuePaymentReservation(runtime.database, {
      workspaceId: selected.workspaceId,
      id: reservation.id,
    });
    throw error;
  }
  const callbackUrl = new URL(
    `/webhooks/fanvue/payments/${reservation.callbackHandle}`,
    origin,
  ).toString();
  try {
    await markFanvueSubscriptionCreationUnknown(runtime.database, {
      workspaceId: selected.workspaceId,
      id: reservation.id,
    });
  } catch (error) {
    // No provider call has started. Cancel only if the durable row proves the
    // transition never committed; a lost commit acknowledgement stays open.
    const current = await getFanvuePaymentSubscriptionForAccount(runtime.database, selected);
    if (current?.id === reservation.id && current.state === 'probe_pending')
      await cancelFanvuePaymentReservation(runtime.database, {
        workspaceId: selected.workspaceId,
        id: reservation.id,
      });
    throw error;
  }
  const created = await runtime.subscriptionClient.create(accessToken, callbackUrl);
  await activateFanvuePaymentSubscription(runtime.database, runtime.keys, {
    workspaceId: selected.workspaceId,
    id: reservation.id,
    providerSubscriptionId: created.id,
    signingSecret: created.signingSecret,
  });
  const current = await getFanvuePaymentSubscriptionForAccount(runtime.database, selected);
  if (
    current?.id !== reservation.id ||
    (current.state !== 'active' && current.state !== 'deletion_required')
  )
    throw new Error('Fanvue payment subscription needs provider reconciliation');
  return current.state;
}

/** Delete exactly the selected creator's known provider subscription before local release. */
export async function deleteFanvuePaymentSubscription(
  runtime: FanvuePaymentSubscriptionRuntime,
  selected: SelectedCreator,
): Promise<void> {
  const current = await getFanvuePaymentSubscriptionForAccount(runtime.database, selected);
  if (
    !current?.providerSubscriptionId ||
    (current.state !== 'active' && current.state !== 'deletion_required')
  )
    throw new Error('Fanvue payment subscription needs reconciliation before delete');
  if (current.creatorUuid !== selected.creatorUuid)
    throw new Error('Fanvue payment subscription creator does not match selected account');
  const token = await getFreshFanvueToken(runtime.database, runtime.keys, runtime.oauthClient, {
    workspaceId: selected.workspaceId,
    creatorId: selected.creatorUuid,
  });
  await runtime.subscriptionClient.delete(token.access_token, current.providerSubscriptionId);
  await disableFanvuePaymentSubscription(runtime.database, {
    workspaceId: selected.workspaceId,
    id: current.id,
    providerSubscriptionId: current.providerSubscriptionId,
  });
}
