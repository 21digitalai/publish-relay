import { createHash, randomBytes } from 'node:crypto';

import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  fanvuePaymentSubscriptions,
  providerAccounts,
  providerConnections,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { createCredential, revokeCredential } from '../credentials/credential.repository.js';
import { encryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
import { FANVUE_PAYMENT_SCOPE } from './fanvue-http-client.js';

interface SelectedAccount {
  workspaceId: string;
  accountId: string;
  creatorUuid: string;
}

async function hasPaymentAccount(
  database: NodePgDatabase,
  input: SelectedAccount,
): Promise<boolean> {
  const [account] = await database
    .select({ id: providerAccounts.id })
    .from(providerAccounts)
    .innerJoin(
      providerConnections,
      and(
        eq(providerConnections.workspaceId, providerAccounts.workspaceId),
        eq(providerConnections.id, providerAccounts.connectionId),
      ),
    )
    .where(
      and(
        eq(providerAccounts.workspaceId, input.workspaceId),
        eq(providerAccounts.id, input.accountId),
        eq(providerAccounts.destinationProvider, 'fanvue'),
        eq(providerAccounts.remoteAccountId, input.creatorUuid),
        eq(providerAccounts.availability, 'active'),
        isNull(providerAccounts.disconnectedAt),
        eq(providerConnections.provider, 'fanvue'),
        eq(providerConnections.externalSubjectId, input.creatorUuid),
        eq(providerConnections.status, 'active'),
        isNull(providerConnections.revokedAt),
        sql`${providerConnections.scopes} @> ${JSON.stringify(['read:self', FANVUE_PAYMENT_SCOPE])}::jsonb`,
      ),
    )
    .for('update')
    .limit(1);
  return Boolean(account);
}

async function requirePaymentAccount(
  database: NodePgDatabase,
  input: SelectedAccount,
): Promise<void> {
  if (!(await hasPaymentAccount(database, input)))
    throw new Error('Fanvue payment creator account is unavailable');
}

/** A one-use callback handle is returned only when its tenant-bound reservation is created. */
export async function reserveFanvuePaymentSubscription(
  database: NodePgDatabase,
  input: SelectedAccount,
): Promise<{ id: string; callbackHandle: string }> {
  z.uuid().parse(input.creatorUuid);
  const callbackHandle = randomBytes(32).toString('base64url');
  const callbackHandleHash = createHash('sha256').update(callbackHandle).digest('hex');
  const id = await withTenantTransaction(database, input, async (transaction) => {
    await requirePaymentAccount(transaction, input);
    const [reserved] = await transaction
      .insert(fanvuePaymentSubscriptions)
      .values({ ...input, callbackHandleHash })
      .returning({ id: fanvuePaymentSubscriptions.id });
    if (!reserved) throw new Error('Fanvue payment subscription reservation failed');
    return reserved.id;
  });
  return { id, callbackHandle };
}

/** Mark the outbound create attempt before contacting Fanvue; never blindly retry ambiguity. */
export async function markFanvueSubscriptionCreationUnknown(
  database: NodePgDatabase,
  input: { workspaceId: string; id: string },
): Promise<void> {
  await withTenantTransaction(database, input, async (transaction) => {
    const [reserved] = await transaction
      .select({
        accountId: fanvuePaymentSubscriptions.accountId,
        creatorUuid: fanvuePaymentSubscriptions.creatorUuid,
      })
      .from(fanvuePaymentSubscriptions)
      .where(
        and(
          eq(fanvuePaymentSubscriptions.workspaceId, input.workspaceId),
          eq(fanvuePaymentSubscriptions.id, input.id),
          eq(fanvuePaymentSubscriptions.state, 'probe_pending'),
        ),
      )
      .for('update')
      .limit(1);
    if (!reserved) throw new Error('Fanvue payment subscription is not ready for creation');
    await requirePaymentAccount(transaction, {
      workspaceId: input.workspaceId,
      accountId: reserved.accountId,
      creatorUuid: reserved.creatorUuid,
    });
    const [updated] = await transaction
      .update(fanvuePaymentSubscriptions)
      .set({ state: 'creation_unknown', updatedAt: new Date() })
      .where(
        and(
          eq(fanvuePaymentSubscriptions.workspaceId, input.workspaceId),
          eq(fanvuePaymentSubscriptions.id, input.id),
          eq(fanvuePaymentSubscriptions.state, 'probe_pending'),
        ),
      )
      .returning({ id: fanvuePaymentSubscriptions.id });
    if (!updated) throw new Error('Fanvue payment subscription is not ready for creation');
  });
}

/** Commit the provider ID and returned-once secret atomically after a confirmed create response. */
export async function activateFanvuePaymentSubscription(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: {
    workspaceId: string;
    id: string;
    providerSubscriptionId: string;
    signingSecret: string;
  },
): Promise<void> {
  if (!input.providerSubscriptionId.trim() || !input.signingSecret)
    throw new Error('Fanvue payment subscription confirmation is incomplete');
  const plaintext = Buffer.from(input.signingSecret);
  let encrypted: Awaited<ReturnType<typeof encryptCredential>>;
  try {
    encrypted = await encryptCredential(plaintext, keys);
  } finally {
    plaintext.fill(0);
  }
  await withTenantTransaction(database, input, async (transaction) => {
    const [pending] = await transaction
      .select({
        id: fanvuePaymentSubscriptions.id,
        accountId: fanvuePaymentSubscriptions.accountId,
        creatorUuid: fanvuePaymentSubscriptions.creatorUuid,
      })
      .from(fanvuePaymentSubscriptions)
      .where(
        and(
          eq(fanvuePaymentSubscriptions.workspaceId, input.workspaceId),
          eq(fanvuePaymentSubscriptions.id, input.id),
          eq(fanvuePaymentSubscriptions.state, 'creation_unknown'),
        ),
      )
      .for('update')
      .limit(1);
    if (!pending) throw new Error('Fanvue payment subscription needs reconciliation');
    // A confirmed provider create after local revocation still needs an exact
    // provider ID for deletion. Never activate or retain its signing secret.
    const authorized = await hasPaymentAccount(transaction, {
      workspaceId: input.workspaceId,
      accountId: pending.accountId,
      creatorUuid: pending.creatorUuid,
    });
    if (!authorized) {
      await transaction
        .update(fanvuePaymentSubscriptions)
        .set({
          providerSubscriptionId: input.providerSubscriptionId,
          state: 'deletion_required',
          updatedAt: new Date(),
        })
        .where(eq(fanvuePaymentSubscriptions.id, pending.id));
      return;
    }
    const credential = await createCredential(transaction, input.workspaceId, encrypted);
    await transaction
      .update(fanvuePaymentSubscriptions)
      .set({
        providerSubscriptionId: input.providerSubscriptionId,
        signingCredentialId: credential.id,
        state: 'active',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(fanvuePaymentSubscriptions.workspaceId, input.workspaceId),
          eq(fanvuePaymentSubscriptions.id, input.id),
          eq(fanvuePaymentSubscriptions.state, 'creation_unknown'),
        ),
      );
  });
}

/** Release an unused reservation, before any outbound create has been marked. */
export async function cancelFanvuePaymentReservation(
  database: NodePgDatabase,
  input: { workspaceId: string; id: string },
): Promise<void> {
  await withTenantTransaction(database, input, async (transaction) => {
    const [cancelled] = await transaction
      .update(fanvuePaymentSubscriptions)
      .set({ state: 'disabled', updatedAt: new Date() })
      .where(
        and(
          eq(fanvuePaymentSubscriptions.workspaceId, input.workspaceId),
          eq(fanvuePaymentSubscriptions.id, input.id),
          eq(fanvuePaymentSubscriptions.state, 'probe_pending'),
        ),
      )
      .returning({ id: fanvuePaymentSubscriptions.id });
    if (!cancelled) throw new Error('Fanvue payment reservation needs reconciliation');
  });
}

/** Release a found ambiguous create only after exact matching provider deletion. */
export async function reconcileDeletedFanvuePaymentSubscription(
  database: NodePgDatabase,
  input: { workspaceId: string; id: string; providerDeletionConfirmed: boolean },
): Promise<void> {
  if (!input.providerDeletionConfirmed)
    throw new Error('Fanvue payment subscription requires confirmed provider deletion');
  await withTenantTransaction(database, input, async (transaction) => {
    const [cancelled] = await transaction
      .update(fanvuePaymentSubscriptions)
      .set({ state: 'disabled', updatedAt: new Date() })
      .where(
        and(
          eq(fanvuePaymentSubscriptions.workspaceId, input.workspaceId),
          eq(fanvuePaymentSubscriptions.id, input.id),
          eq(fanvuePaymentSubscriptions.state, 'creation_unknown'),
          isNull(fanvuePaymentSubscriptions.providerSubscriptionId),
        ),
      )
      .returning({ id: fanvuePaymentSubscriptions.id });
    if (!cancelled) throw new Error('Fanvue payment subscription needs reconciliation');
  });
}

export async function getFanvuePaymentSubscriptionForAccount(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string },
) {
  return withTenantTransaction(database, input, async (transaction) => {
    const [row] = await transaction
      .select({
        id: fanvuePaymentSubscriptions.id,
        creatorUuid: fanvuePaymentSubscriptions.creatorUuid,
        callbackHandleHash: fanvuePaymentSubscriptions.callbackHandleHash,
        providerSubscriptionId: fanvuePaymentSubscriptions.providerSubscriptionId,
        state: fanvuePaymentSubscriptions.state,
      })
      .from(fanvuePaymentSubscriptions)
      .where(
        and(
          eq(fanvuePaymentSubscriptions.workspaceId, input.workspaceId),
          eq(fanvuePaymentSubscriptions.accountId, input.accountId),
          ne(fanvuePaymentSubscriptions.state, 'disabled'),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/** Call only after confirmed provider deletion; retain the row as disabled history. */
export async function disableFanvuePaymentSubscription(
  database: NodePgDatabase,
  input: { workspaceId: string; id: string; providerSubscriptionId: string },
): Promise<void> {
  await withTenantTransaction(database, input, async (transaction) => {
    const [current] = await transaction
      .select({ signingCredentialId: fanvuePaymentSubscriptions.signingCredentialId })
      .from(fanvuePaymentSubscriptions)
      .where(
        and(
          eq(fanvuePaymentSubscriptions.workspaceId, input.workspaceId),
          eq(fanvuePaymentSubscriptions.id, input.id),
          eq(fanvuePaymentSubscriptions.providerSubscriptionId, input.providerSubscriptionId),
          sql`${fanvuePaymentSubscriptions.state} IN ('active', 'deletion_required')`,
        ),
      )
      .for('update')
      .limit(1);
    if (!current) throw new Error('Fanvue payment subscription deletion needs reconciliation');
    await transaction
      .update(fanvuePaymentSubscriptions)
      .set({ state: 'disabled', updatedAt: new Date() })
      .where(
        and(
          eq(fanvuePaymentSubscriptions.workspaceId, input.workspaceId),
          eq(fanvuePaymentSubscriptions.id, input.id),
        ),
      );
    if (current.signingCredentialId)
      await revokeCredential(
        transaction,
        input.workspaceId,
        current.signingCredentialId,
        new Date(),
      );
  });
}
