import { createHash } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  fanvuePaymentSubscriptions,
  providerAccounts,
  providerConnections,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { getActiveCredential } from '../credentials/credential.repository.js';
import { decryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
import type { FanvuePaymentSubscription } from './fanvue-payment-delivery.service.js';
import { FANVUE_PAYMENT_SCOPE } from './fanvue-http-client.js';

const CALLBACK_HANDLE = /^[A-Za-z0-9_-]{43}$/;

type CallbackResolution =
  { state: 'probe_pending' } | { state: 'active'; subscription: FanvuePaymentSubscription };

/** Opaque-handle lookup is the only cross-tenant read; every secret read then uses tenant RLS. */
export async function resolveFanvuePaymentCallback(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  callbackHandle: string,
): Promise<CallbackResolution | null> {
  if (!CALLBACK_HANDLE.test(callbackHandle)) return null;
  const handleHash = createHash('sha256').update(callbackHandle).digest('hex');
  const result = await database.execute<{
    workspace_id: string;
    account_id: string;
    creator_uuid: string;
    signing_credential_id: string | null;
    state: string;
  }>(sql`SELECT * FROM public.resolve_fanvue_payment_callback(${handleHash})`);
  const resolved = result.rows[0];
  if (!resolved) return null;
  if (resolved.state === 'probe_pending' || resolved.state === 'creation_unknown')
    return { state: 'probe_pending' };
  if (resolved.state !== 'active' || !resolved.signing_credential_id) return null;
  const signingCredentialId = resolved.signing_credential_id;

  return withTenantTransaction(
    database,
    { workspaceId: resolved.workspace_id },
    async (transaction) => {
      const [current] = await transaction
        .select({ id: fanvuePaymentSubscriptions.id })
        .from(fanvuePaymentSubscriptions)
        .innerJoin(
          providerAccounts,
          and(
            eq(providerAccounts.workspaceId, fanvuePaymentSubscriptions.workspaceId),
            eq(providerAccounts.id, fanvuePaymentSubscriptions.accountId),
          ),
        )
        .innerJoin(
          providerConnections,
          and(
            eq(providerConnections.workspaceId, providerAccounts.workspaceId),
            eq(providerConnections.id, providerAccounts.connectionId),
          ),
        )
        .where(
          and(
            eq(fanvuePaymentSubscriptions.workspaceId, resolved.workspace_id),
            eq(fanvuePaymentSubscriptions.accountId, resolved.account_id),
            eq(fanvuePaymentSubscriptions.creatorUuid, resolved.creator_uuid),
            eq(fanvuePaymentSubscriptions.callbackHandleHash, handleHash),
            eq(fanvuePaymentSubscriptions.signingCredentialId, signingCredentialId),
            eq(fanvuePaymentSubscriptions.state, 'active'),
            eq(providerAccounts.destinationProvider, 'fanvue'),
            eq(providerAccounts.remoteAccountId, resolved.creator_uuid),
            eq(providerAccounts.availability, 'active'),
            isNull(providerAccounts.disconnectedAt),
            eq(providerConnections.provider, 'fanvue'),
            eq(providerConnections.externalSubjectId, resolved.creator_uuid),
            eq(providerConnections.status, 'active'),
            isNull(providerConnections.revokedAt),
            sql`${providerConnections.scopes} @> ${JSON.stringify(['read:self', FANVUE_PAYMENT_SCOPE])}::jsonb`,
          ),
        )
        .limit(1);
      if (!current) return null;
      const credential = await getActiveCredential(
        transaction,
        resolved.workspace_id,
        signingCredentialId,
      );
      if (!credential) return null;
      const plaintext = await decryptCredential(credential, keys);
      try {
        return {
          state: 'active' as const,
          subscription: {
            workspaceId: resolved.workspace_id,
            accountId: resolved.account_id,
            creatorUuid: resolved.creator_uuid,
            signingSecrets: [plaintext.toString('utf8')],
          },
        };
      } finally {
        plaintext.fill(0);
      }
    },
  );
}
