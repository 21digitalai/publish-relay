import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { fanvueDmConversationState, providerAccounts } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

const identity = z.strictObject({
  workspaceId: z.uuid(),
  accountId: z.uuid(),
  fanUuid: z.uuid(),
});
const accountIdentity = identity.pick({ workspaceId: true, accountId: true });
const observedSummary = identity.extend({
  latestMessageUuid: z.uuid(),
  latestMessageAt: z.date(),
  latestDirection: z.enum(['inbound', 'outbound']),
  providerIsRead: z.boolean().nullable(),
  providerUnreadCount: z.number().int().nonnegative().nullable(),
  observedAt: z.date(),
});
const workflowUpdate = identity.extend({
  lastProcessedInboundUuid: z.uuid().optional(),
  lastProcessedInboundAt: z.date().optional(),
  nextReviewAt: z.date().nullable().optional(),
  quietUntilInboundAfterUuid: z.uuid().nullable().optional(),
  historyCoverageOldestAt: z.date().optional(),
  historyBackfillCompleteAt: z.date().optional(),
});

export class FanvueDmConversationStateUnavailableError extends Error {
  constructor() {
    super('Fanvue conversation state account is unavailable');
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
  if (account?.provider !== 'fanvue') throw new FanvueDmConversationStateUnavailableError();
}

export async function observeFanvueDmConversationSummary(
  database: NodePgDatabase,
  unparsed: z.input<typeof observedSummary>,
) {
  const input = observedSummary.parse(unparsed);
  return withTenantTransaction(database, input, async (transaction) => {
    await requireFanvueAccount(transaction, input);
    const [existing] = await transaction
      .select()
      .from(fanvueDmConversationState)
      .where(
        and(
          eq(fanvueDmConversationState.workspaceId, input.workspaceId),
          eq(fanvueDmConversationState.accountId, input.accountId),
          eq(fanvueDmConversationState.fanUuid, input.fanUuid),
        ),
      )
      .for('update')
      .limit(1);
    if (existing?.latestObservedAt) {
      const isOlder = input.latestMessageAt.getTime() < existing.latestObservedAt.getTime();
      const isAmbiguousEqualTime =
        input.latestMessageAt.getTime() === existing.latestObservedAt.getTime() &&
        input.latestMessageUuid !== existing.latestObservedMessageUuid;
      if (isOlder || isAmbiguousEqualTime) return existing;
    }
    const isNewInbound =
      input.latestDirection === 'inbound' &&
      input.latestMessageUuid !== existing?.latestInboundMessageUuid;
    const values = {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      fanUuid: input.fanUuid,
      latestObservedMessageUuid: input.latestMessageUuid,
      latestObservedAt: input.latestMessageAt,
      latestObservedDirection: input.latestDirection,
      latestInboundMessageUuid:
        input.latestDirection === 'inbound'
          ? input.latestMessageUuid
          : (existing?.latestInboundMessageUuid ?? null),
      latestInboundAt:
        input.latestDirection === 'inbound'
          ? input.latestMessageAt
          : (existing?.latestInboundAt ?? null),
      latestOutboundMessageUuid:
        input.latestDirection === 'outbound'
          ? input.latestMessageUuid
          : (existing?.latestOutboundMessageUuid ?? null),
      latestOutboundAt:
        input.latestDirection === 'outbound'
          ? input.latestMessageAt
          : (existing?.latestOutboundAt ?? null),
      providerIsRead: input.providerIsRead,
      providerUnreadCount: input.providerUnreadCount,
      lastChatListSeenAt: input.observedAt,
      quietUntilInboundAfterUuid: isNewInbound
        ? null
        : (existing?.quietUntilInboundAfterUuid ?? null),
      nextReviewAt: isNewInbound ? input.observedAt : (existing?.nextReviewAt ?? null),
      updatedAt: input.observedAt,
    };
    const [row] = existing
      ? await transaction
          .update(fanvueDmConversationState)
          .set(values)
          .where(
            and(
              eq(fanvueDmConversationState.workspaceId, input.workspaceId),
              eq(fanvueDmConversationState.accountId, input.accountId),
              eq(fanvueDmConversationState.fanUuid, input.fanUuid),
            ),
          )
          .returning()
      : await transaction.insert(fanvueDmConversationState).values(values).returning();
    if (!row) throw new Error('Fanvue conversation summary upsert failed');
    return row;
  });
}

export async function updateFanvueDmConversationWorkflow(
  database: NodePgDatabase,
  unparsed: z.input<typeof workflowUpdate>,
) {
  const input = workflowUpdate.parse(unparsed);
  return withTenantTransaction(database, input, async (transaction) => {
    await requireFanvueAccount(transaction, input);
    const [row] = await transaction
      .update(fanvueDmConversationState)
      .set({
        ...(input.lastProcessedInboundUuid !== undefined
          ? { lastProcessedInboundUuid: input.lastProcessedInboundUuid }
          : {}),
        ...(input.lastProcessedInboundAt !== undefined
          ? { lastProcessedInboundAt: input.lastProcessedInboundAt }
          : {}),
        ...(input.nextReviewAt !== undefined ? { nextReviewAt: input.nextReviewAt } : {}),
        ...(input.quietUntilInboundAfterUuid !== undefined
          ? { quietUntilInboundAfterUuid: input.quietUntilInboundAfterUuid }
          : {}),
        ...(input.historyCoverageOldestAt !== undefined
          ? { historyCoverageOldestAt: input.historyCoverageOldestAt }
          : {}),
        ...(input.historyBackfillCompleteAt !== undefined
          ? { historyBackfillCompleteAt: input.historyBackfillCompleteAt }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(fanvueDmConversationState.workspaceId, input.workspaceId),
          eq(fanvueDmConversationState.accountId, input.accountId),
          eq(fanvueDmConversationState.fanUuid, input.fanUuid),
        ),
      )
      .returning();
    return row ?? null;
  });
}

export async function listDueFanvueDmConversations(
  database: NodePgDatabase,
  unparsed: z.input<typeof accountIdentity> & {
    now: Date;
    limit?: number;
  },
) {
  const input = accountIdentity
    .extend({ now: z.date(), limit: z.number().int().min(1).max(100).default(50) })
    .parse(unparsed);
  return withTenantTransaction(database, input, (transaction) =>
    transaction
      .select({
        fanUuid: fanvueDmConversationState.fanUuid,
        latestObservedMessageUuid: fanvueDmConversationState.latestObservedMessageUuid,
        latestObservedAt: fanvueDmConversationState.latestObservedAt,
        latestInboundMessageUuid: fanvueDmConversationState.latestInboundMessageUuid,
        latestInboundAt: fanvueDmConversationState.latestInboundAt,
        providerIsRead: fanvueDmConversationState.providerIsRead,
        providerUnreadCount: fanvueDmConversationState.providerUnreadCount,
        nextReviewAt: fanvueDmConversationState.nextReviewAt,
        historyBackfillCompleteAt: fanvueDmConversationState.historyBackfillCompleteAt,
      })
      .from(fanvueDmConversationState)
      .where(
        and(
          eq(fanvueDmConversationState.workspaceId, input.workspaceId),
          eq(fanvueDmConversationState.accountId, input.accountId),
          isNull(fanvueDmConversationState.quietUntilInboundAfterUuid),
          lte(fanvueDmConversationState.nextReviewAt, input.now),
        ),
      )
      .orderBy(asc(fanvueDmConversationState.nextReviewAt), asc(fanvueDmConversationState.fanUuid))
      .limit(input.limit),
  );
}
