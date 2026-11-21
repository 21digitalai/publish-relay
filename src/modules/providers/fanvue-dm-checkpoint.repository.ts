import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { fanvueDmConversationCheckpoints, providerAccounts } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

const identity = z.strictObject({
  workspaceId: z.uuid(),
  accountId: z.uuid(),
  fanUuid: z.uuid(),
  kind: z.enum(['welcome', 'silent_followup', 'free_gift', 'paid_offer']),
  ordinal: z.number().int().positive(),
});
const fanIdentity = identity.pick({ workspaceId: true, accountId: true, fanUuid: true });
const reservation = identity.extend({
  clientActionId: z.uuid(),
  groupId: z.uuid().nullable().default(null),
  providerMediaUuid: z.uuid().nullable().default(null),
});
export const fanvueDmCheckpointIntent = reservation.omit({
  workspaceId: true,
  accountId: true,
  fanUuid: true,
  clientActionId: true,
});
const settlementIdentity = identity.extend({ clientActionId: z.uuid() });
const settlement = z.discriminatedUnion('state', [
  settlementIdentity.extend({
    state: z.literal('confirmed'),
    providerMessageUuid: z.uuid(),
  }),
  settlementIdentity.extend({ state: z.literal('unknown') }),
  settlementIdentity.extend({ state: z.literal('cancelled') }),
]);

const MAX_FANVUE_DM_CHECKPOINTS_PER_FAN = 100;

export class FanvueDmCheckpointConflictError extends Error {
  constructor() {
    super('Fanvue conversation checkpoint conflicts with prior intent');
  }
}

export async function reserveFanvueDmCheckpoint(
  database: NodePgDatabase,
  unparsed: z.input<typeof reservation>,
) {
  const input = reservation.parse(unparsed);
  return withTenantTransaction(database, input, async (transaction) => {
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
    if (account?.provider !== 'fanvue') throw new FanvueDmCheckpointConflictError();
    const [existing] = await transaction
      .select()
      .from(fanvueDmConversationCheckpoints)
      .where(
        and(
          eq(fanvueDmConversationCheckpoints.workspaceId, input.workspaceId),
          eq(fanvueDmConversationCheckpoints.accountId, input.accountId),
          eq(fanvueDmConversationCheckpoints.fanUuid, input.fanUuid),
          eq(fanvueDmConversationCheckpoints.kind, input.kind),
          eq(fanvueDmConversationCheckpoints.ordinal, input.ordinal),
        ),
      )
      .for('update')
      .limit(1);
    if (existing) {
      if (
        existing.clientActionId !== input.clientActionId ||
        existing.groupId !== input.groupId ||
        existing.providerMediaUuid !== input.providerMediaUuid ||
        existing.state === 'cancelled'
      )
        throw new FanvueDmCheckpointConflictError();
      return existing;
    }
    const [created] = await transaction
      .insert(fanvueDmConversationCheckpoints)
      .values({ ...input, state: 'pending' })
      .returning();
    if (!created) throw new Error('Fanvue conversation checkpoint reservation failed');
    return created;
  });
}

export async function settleFanvueDmCheckpoint(
  database: NodePgDatabase,
  unparsed: z.input<typeof settlement>,
) {
  const input = settlement.parse(unparsed);
  return withTenantTransaction(database, input, async (transaction) => {
    const [row] = await transaction
      .update(fanvueDmConversationCheckpoints)
      .set({
        state: input.state,
        providerMessageUuid: input.state === 'confirmed' ? input.providerMessageUuid : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(fanvueDmConversationCheckpoints.workspaceId, input.workspaceId),
          eq(fanvueDmConversationCheckpoints.accountId, input.accountId),
          eq(fanvueDmConversationCheckpoints.fanUuid, input.fanUuid),
          eq(fanvueDmConversationCheckpoints.kind, input.kind),
          eq(fanvueDmConversationCheckpoints.ordinal, input.ordinal),
          eq(fanvueDmConversationCheckpoints.clientActionId, input.clientActionId),
          eq(fanvueDmConversationCheckpoints.state, 'pending'),
        ),
      )
      .returning();
    if (!row) {
      const [existing] = await transaction
        .select()
        .from(fanvueDmConversationCheckpoints)
        .where(
          and(
            eq(fanvueDmConversationCheckpoints.workspaceId, input.workspaceId),
            eq(fanvueDmConversationCheckpoints.accountId, input.accountId),
            eq(fanvueDmConversationCheckpoints.fanUuid, input.fanUuid),
            eq(fanvueDmConversationCheckpoints.kind, input.kind),
            eq(fanvueDmConversationCheckpoints.ordinal, input.ordinal),
            eq(fanvueDmConversationCheckpoints.clientActionId, input.clientActionId),
          ),
        )
        .limit(1);
      const sameTerminalState =
        existing?.state === input.state &&
        (input.state !== 'confirmed' || existing.providerMessageUuid === input.providerMessageUuid);
      if (!sameTerminalState) throw new FanvueDmCheckpointConflictError();
      return existing;
    }
    return row;
  });
}

export async function findFanvueDmCheckpointForAction(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; fanUuid: string; clientActionId: string },
) {
  return withTenantTransaction(database, input, async (transaction) => {
    const [row] = await transaction
      .select()
      .from(fanvueDmConversationCheckpoints)
      .where(
        and(
          eq(fanvueDmConversationCheckpoints.workspaceId, input.workspaceId),
          eq(fanvueDmConversationCheckpoints.accountId, input.accountId),
          eq(fanvueDmConversationCheckpoints.fanUuid, input.fanUuid),
          eq(fanvueDmConversationCheckpoints.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function listFanvueDmCheckpoints(
  database: NodePgDatabase,
  input: z.input<typeof fanIdentity>,
) {
  const parsed = fanIdentity.parse(input);
  return withTenantTransaction(database, parsed, (transaction) =>
    transaction
      .select({
        kind: fanvueDmConversationCheckpoints.kind,
        ordinal: fanvueDmConversationCheckpoints.ordinal,
        state: fanvueDmConversationCheckpoints.state,
        providerMessageUuid: fanvueDmConversationCheckpoints.providerMessageUuid,
        providerMediaUuid: fanvueDmConversationCheckpoints.providerMediaUuid,
      })
      .from(fanvueDmConversationCheckpoints)
      .where(
        and(
          eq(fanvueDmConversationCheckpoints.workspaceId, parsed.workspaceId),
          eq(fanvueDmConversationCheckpoints.accountId, parsed.accountId),
          eq(fanvueDmConversationCheckpoints.fanUuid, parsed.fanUuid),
        ),
      )
      .orderBy(
        asc(fanvueDmConversationCheckpoints.kind),
        asc(fanvueDmConversationCheckpoints.ordinal),
      )
      .limit(MAX_FANVUE_DM_CHECKPOINTS_PER_FAN),
  );
}
