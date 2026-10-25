import { createHash } from 'node:crypto';

import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  fanvuePaymentReceipts,
  providerAccounts,
  providerConnections,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { FanvuePaymentSignal } from './fanvue-payment-event.js';

/** A signed event may be receipted for each selected creator connection independently. */
export async function receiptFanvuePaymentForAccount(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; signal: FanvuePaymentSignal },
): Promise<'recorded' | 'duplicate'> {
  z.uuid().parse(input.workspaceId);
  z.uuid().parse(input.accountId);
  z.uuid().parse(input.signal.eventId);
  const fingerprint = createHash('sha256').update(JSON.stringify(input.signal)).digest('hex');
  return withTenantTransaction(database, input, async (transaction) => {
    const selected = await transaction
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .innerJoin(
        providerConnections,
        and(
          eq(providerConnections.id, providerAccounts.connectionId),
          eq(providerConnections.workspaceId, providerAccounts.workspaceId),
        ),
      )
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.id, input.accountId),
          eq(providerAccounts.destinationProvider, 'fanvue'),
          eq(providerAccounts.remoteAccountId, input.signal.creatorUuid),
          eq(providerAccounts.availability, 'active'),
          eq(providerConnections.provider, 'fanvue'),
          eq(providerConnections.externalSubjectId, input.signal.creatorUuid),
          eq(providerConnections.status, 'active'),
        ),
      )
      .limit(1);
    if (!selected[0]) throw new Error('Fanvue payment creator account is unavailable');

    const signal = input.signal;
    const inserted = await transaction
      .insert(fanvuePaymentReceipts)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        eventId: signal.eventId,
        eventFingerprint: fingerprint,
        creatorUuid: signal.creatorUuid,
        fanUuid: signal.fanUuid,
        invoiceId: signal.invoiceId,
        source: signal.source,
        grossMinor: signal.grossMinor,
        currency: signal.currency,
        paidAt: signal.paidAt ? new Date(signal.paidAt) : null,
        eventAt: new Date(signal.eventAt),
        postUuid: signal.postUuid,
        messageUuid: signal.messageUuid,
        tipContext: signal.tipContext,
      })
      .onConflictDoNothing()
      .returning({ id: fanvuePaymentReceipts.id });
    if (inserted[0]) return 'recorded';
    const existing = await transaction
      .select({ fingerprint: fanvuePaymentReceipts.eventFingerprint })
      .from(fanvuePaymentReceipts)
      .where(
        and(
          eq(fanvuePaymentReceipts.workspaceId, input.workspaceId),
          eq(fanvuePaymentReceipts.accountId, input.accountId),
          eq(fanvuePaymentReceipts.eventId, signal.eventId),
        ),
      )
      .limit(1);
    if (existing[0]?.fingerprint !== fingerprint)
      throw new Error('Fanvue payment event ID conflicts with prior facts');
    return 'duplicate';
  });
}

export async function listFanvuePaymentSignals(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    accountId: string;
    limit: number;
    before?: { eventAt: Date; id: string };
  },
) {
  return withTenantTransaction(database, input, (transaction) =>
    transaction
      .select({
        id: fanvuePaymentReceipts.id,
        eventId: fanvuePaymentReceipts.eventId,
        fanUuid: fanvuePaymentReceipts.fanUuid,
        invoiceId: fanvuePaymentReceipts.invoiceId,
        source: fanvuePaymentReceipts.source,
        grossMinor: fanvuePaymentReceipts.grossMinor,
        currency: fanvuePaymentReceipts.currency,
        paidAt: fanvuePaymentReceipts.paidAt,
        eventAt: fanvuePaymentReceipts.eventAt,
        postUuid: fanvuePaymentReceipts.postUuid,
        messageUuid: fanvuePaymentReceipts.messageUuid,
        tipContext: fanvuePaymentReceipts.tipContext,
      })
      .from(fanvuePaymentReceipts)
      .where(
        and(
          eq(fanvuePaymentReceipts.workspaceId, input.workspaceId),
          eq(fanvuePaymentReceipts.accountId, input.accountId),
          ...(input.before
            ? [
                or(
                  lt(fanvuePaymentReceipts.eventAt, input.before.eventAt),
                  and(
                    eq(fanvuePaymentReceipts.eventAt, input.before.eventAt),
                    lt(fanvuePaymentReceipts.id, input.before.id),
                  ),
                ),
              ]
            : []),
        ),
      )
      .orderBy(desc(fanvuePaymentReceipts.eventAt), desc(fanvuePaymentReceipts.id))
      .limit(input.limit),
  );
}
