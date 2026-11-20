import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { fanvueDmMediaDeliveries, providerAccounts } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

const identity = z.strictObject({
  workspaceId: z.uuid(),
  accountId: z.uuid(),
  fanUuid: z.uuid(),
});
const reservation = identity.extend({
  clientActionId: z.uuid(),
  providerMediaUuids: z.array(z.uuid()).min(1).max(10),
});
const settlement = identity.extend({
  clientActionId: z.uuid(),
  state: z.enum(['confirmed', 'unknown']),
  providerMessageUuid: z.uuid().optional(),
  priceCents: z.number().int().nonnegative().optional(),
  purchasedAt: z.date().optional(),
});
const historyReceipt = identity.extend({
  providerMediaUuid: z.uuid(),
  providerMessageUuid: z.uuid(),
  priceCents: z.number().int().nonnegative().optional(),
  purchasedAt: z.date().optional(),
});

export class FanvueDmMediaAlreadyUsedError extends Error {
  constructor() {
    super('Fanvue media is already reserved or observed for this fan');
  }
}

async function requireFanvueAccount(transaction: NodePgDatabase, input: z.output<typeof identity>) {
  const [account] = await transaction
    .select({ provider: providerAccounts.destinationProvider })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.workspaceId, input.workspaceId),
        eq(providerAccounts.id, input.accountId),
      ),
    )
    .for('update')
    .limit(1);
  if (account?.provider !== 'fanvue') throw new FanvueDmMediaAlreadyUsedError();
}

export async function reserveFanvueDmMedia(
  database: NodePgDatabase,
  unparsed: z.input<typeof reservation>,
) {
  const input = reservation.parse(unparsed);
  const providerMediaUuids = [...new Set(input.providerMediaUuids)];
  if (providerMediaUuids.length !== input.providerMediaUuids.length)
    throw new FanvueDmMediaAlreadyUsedError();
  return withTenantTransaction(database, input, async (transaction) => {
    await requireFanvueAccount(transaction, input);
    const existing = await transaction
      .select({
        id: fanvueDmMediaDeliveries.id,
        providerMediaUuid: fanvueDmMediaDeliveries.providerMediaUuid,
        state: fanvueDmMediaDeliveries.state,
      })
      .from(fanvueDmMediaDeliveries)
      .where(
        and(
          eq(fanvueDmMediaDeliveries.workspaceId, input.workspaceId),
          eq(fanvueDmMediaDeliveries.accountId, input.accountId),
          eq(fanvueDmMediaDeliveries.fanUuid, input.fanUuid),
          eq(fanvueDmMediaDeliveries.clientActionId, input.clientActionId),
        ),
      );
    if (existing.length > 0) {
      const existingMedia = existing.map((row) => row.providerMediaUuid).sort();
      const requestedMedia = [...providerMediaUuids].sort();
      if (
        existing.some((row) => row.state === 'cancelled') ||
        existingMedia.length !== requestedMedia.length ||
        existingMedia.some((value, index) => value !== requestedMedia[index])
      )
        throw new FanvueDmMediaAlreadyUsedError();
      return existing.map((row) => row.id);
    }
    const inserted = await transaction
      .insert(fanvueDmMediaDeliveries)
      .values(
        providerMediaUuids.map((providerMediaUuid) => ({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          fanUuid: input.fanUuid,
          providerMediaUuid,
          source: 'relay_action',
          clientActionId: input.clientActionId,
          state: 'reserved',
        })),
      )
      .onConflictDoNothing()
      .returning({ id: fanvueDmMediaDeliveries.id });
    if (inserted.length !== providerMediaUuids.length) throw new FanvueDmMediaAlreadyUsedError();
    return inserted.map((row) => row.id);
  });
}

export async function settleFanvueDmMedia(
  database: NodePgDatabase,
  unparsed: z.input<typeof settlement>,
) {
  const input = settlement.parse(unparsed);
  if (input.state === 'confirmed' && !input.providerMessageUuid)
    throw new Error('Confirmed Fanvue media delivery requires a provider message UUID');
  return withTenantTransaction(database, input, async (transaction) =>
    transaction
      .update(fanvueDmMediaDeliveries)
      .set({
        state: input.state,
        providerMessageUuid: input.providerMessageUuid ?? null,
        priceCents: input.priceCents ?? null,
        purchasedAt: input.purchasedAt ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(fanvueDmMediaDeliveries.workspaceId, input.workspaceId),
          eq(fanvueDmMediaDeliveries.accountId, input.accountId),
          eq(fanvueDmMediaDeliveries.fanUuid, input.fanUuid),
          eq(fanvueDmMediaDeliveries.clientActionId, input.clientActionId),
          eq(fanvueDmMediaDeliveries.state, 'reserved'),
        ),
      )
      .returning({ id: fanvueDmMediaDeliveries.id }),
  );
}

export async function cancelReservedFanvueDmMedia(
  database: NodePgDatabase,
  unparsed: z.input<typeof identity> & { clientActionId: string },
) {
  const input = identity.extend({ clientActionId: z.uuid() }).parse(unparsed);
  return withTenantTransaction(database, input, async (transaction) =>
    transaction
      .update(fanvueDmMediaDeliveries)
      .set({ state: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(fanvueDmMediaDeliveries.workspaceId, input.workspaceId),
          eq(fanvueDmMediaDeliveries.accountId, input.accountId),
          eq(fanvueDmMediaDeliveries.fanUuid, input.fanUuid),
          eq(fanvueDmMediaDeliveries.clientActionId, input.clientActionId),
          eq(fanvueDmMediaDeliveries.state, 'reserved'),
        ),
      )
      .returning({ id: fanvueDmMediaDeliveries.id }),
  );
}

export async function recordFanvueDmHistoryMedia(
  database: NodePgDatabase,
  unparsed: z.input<typeof historyReceipt>,
) {
  const input = historyReceipt.parse(unparsed);
  return withTenantTransaction(database, input, async (transaction) => {
    await requireFanvueAccount(transaction, input);
    const [inserted] = await transaction
      .insert(fanvueDmMediaDeliveries)
      .values({
        ...input,
        source: 'provider_history',
        state: 'confirmed',
        priceCents: input.priceCents ?? null,
        purchasedAt: input.purchasedAt ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: fanvueDmMediaDeliveries.id });
    return inserted?.id ?? null;
  });
}

export async function listFanvueDmMediaDeliveryStates(
  database: NodePgDatabase,
  input: z.input<typeof identity> & { providerMediaUuids: string[] },
) {
  const parsed = identity
    .extend({ providerMediaUuids: z.array(z.uuid()).min(1).max(100) })
    .parse(input);
  return withTenantTransaction(database, parsed, (transaction) =>
    transaction
      .select({
        providerMediaUuid: fanvueDmMediaDeliveries.providerMediaUuid,
        state: fanvueDmMediaDeliveries.state,
        source: fanvueDmMediaDeliveries.source,
        purchasedAt: fanvueDmMediaDeliveries.purchasedAt,
      })
      .from(fanvueDmMediaDeliveries)
      .where(
        and(
          eq(fanvueDmMediaDeliveries.workspaceId, parsed.workspaceId),
          eq(fanvueDmMediaDeliveries.accountId, parsed.accountId),
          eq(fanvueDmMediaDeliveries.fanUuid, parsed.fanUuid),
          inArray(fanvueDmMediaDeliveries.providerMediaUuid, parsed.providerMediaUuids),
        ),
      ),
  );
}
