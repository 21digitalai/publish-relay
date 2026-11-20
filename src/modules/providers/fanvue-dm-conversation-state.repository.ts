import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  fanvueDmConversationState,
  fanvueActionIntents,
  fanvueDmMediaDeliveries,
  fanvueDmMessageReceipts,
  fanvueDmPendingIntents,
  providerAccounts,
} from '../../database/schema.js';
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
const messageReceipt = identity
  .extend({
    providerMessageUuid: z.uuid(),
    direction: z.enum(['inbound', 'outbound']),
    exchangeRole: z.enum(['inbound_turn', 'outbound_root', 'outbound_tail', 'automation']),
    sentAt: z.date(),
    mediaUuids: z.array(z.uuid()).max(20).default([]),
    priceCents: z.number().int().nonnegative().nullable().default(null),
    purchasedAt: z.date().nullable().default(null),
    observedAt: z.date(),
  })
  .superRefine((value, context) => {
    if (
      (value.direction === 'inbound' && value.exchangeRole !== 'inbound_turn') ||
      (value.direction === 'outbound' && value.exchangeRole === 'inbound_turn')
    )
      context.addIssue({
        code: 'custom',
        message: 'Exchange role does not match message direction',
      });
  });
const historyMessage = identity.omit({ workspaceId: true, accountId: true, fanUuid: true }).extend({
  providerMessageUuid: z.uuid(),
  direction: z.enum(['inbound', 'outbound']),
  sentAt: z.date(),
  mediaUuids: z.array(z.uuid()).max(50),
  priceCents: z.number().int().nonnegative().nullable(),
  purchasedAt: z.date().nullable(),
  excludeMedia: z.boolean().default(false),
});
const historyPage = identity.extend({
  messages: z.array(historyMessage).max(50),
  hasMore: z.boolean(),
  observedAt: z.date(),
});
const historyFailure = identity.extend({
  failureCode: z.enum([
    'provider_read_failed',
    'invalid_message_direction',
    'invalid_message_timestamp',
    'page_ingest_failed',
    'page_limit_reached',
  ]),
  observedAt: z.date(),
});

export class FanvueDmConversationStateUnavailableError extends Error {
  constructor() {
    super('Fanvue conversation state account is unavailable');
  }
}

export class FanvueDmMessageReceiptConflictError extends Error {
  constructor() {
    super('Fanvue message receipt conflicts with prior provider identity');
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

type MessageReceiptInput = z.output<typeof messageReceipt>;

async function upsertMessageReceipt(transaction: NodePgDatabase, input: MessageReceiptInput) {
  const [existing] = await transaction
    .select()
    .from(fanvueDmMessageReceipts)
    .where(
      and(
        eq(fanvueDmMessageReceipts.workspaceId, input.workspaceId),
        eq(fanvueDmMessageReceipts.accountId, input.accountId),
        eq(fanvueDmMessageReceipts.providerMessageUuid, input.providerMessageUuid),
      ),
    )
    .for('update')
    .limit(1);
  if (
    existing &&
    (existing.fanUuid !== input.fanUuid ||
      existing.direction !== input.direction ||
      existing.exchangeRole !== input.exchangeRole ||
      existing.sentAt.getTime() !== input.sentAt.getTime())
  )
    throw new FanvueDmMessageReceiptConflictError();
  const values = { ...input, updatedAt: input.observedAt };
  const [receipt] = !existing
    ? await transaction.insert(fanvueDmMessageReceipts).values(values).returning()
    : input.observedAt.getTime() >= existing.observedAt.getTime()
      ? await transaction
          .update(fanvueDmMessageReceipts)
          .set(values)
          .where(eq(fanvueDmMessageReceipts.id, existing.id))
          .returning()
      : [existing];
  if (!receipt) throw new Error('Fanvue message receipt upsert failed');
  return receipt;
}

async function advanceReceiptBoundary(transaction: NodePgDatabase, input: MessageReceiptInput) {
  const [state] = await transaction
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
  const currentAt =
    input.direction === 'inbound' ? state?.latestInboundAt : state?.latestOutboundAt;
  const currentUuid =
    input.direction === 'inbound'
      ? state?.latestInboundMessageUuid
      : state?.latestOutboundMessageUuid;
  if (input.sentAt.getTime() === currentAt?.getTime() && currentUuid !== input.providerMessageUuid)
    throw new FanvueDmMessageReceiptConflictError();
  if (currentAt && input.sentAt.getTime() <= currentAt.getTime()) return;
  const boundary = {
    ...(input.direction === 'inbound'
      ? {
          latestInboundMessageUuid: input.providerMessageUuid,
          latestInboundAt: input.sentAt,
        }
      : {
          latestOutboundMessageUuid: input.providerMessageUuid,
          latestOutboundAt: input.sentAt,
        }),
    updatedAt: input.observedAt,
  };
  if (state)
    await transaction
      .update(fanvueDmConversationState)
      .set(boundary)
      .where(
        and(
          eq(fanvueDmConversationState.workspaceId, input.workspaceId),
          eq(fanvueDmConversationState.accountId, input.accountId),
          eq(fanvueDmConversationState.fanUuid, input.fanUuid),
        ),
      );
  else
    await transaction.insert(fanvueDmConversationState).values({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      fanUuid: input.fanUuid,
      ...boundary,
    });
}

async function refreshConversationCounts(transaction: NodePgDatabase, input: MessageReceiptInput) {
  const receipts = await transaction
    .select({
      providerMessageUuid: fanvueDmMessageReceipts.providerMessageUuid,
      direction: fanvueDmMessageReceipts.direction,
      exchangeRole: fanvueDmMessageReceipts.exchangeRole,
      sentAt: fanvueDmMessageReceipts.sentAt,
    })
    .from(fanvueDmMessageReceipts)
    .where(
      and(
        eq(fanvueDmMessageReceipts.workspaceId, input.workspaceId),
        eq(fanvueDmMessageReceipts.accountId, input.accountId),
        eq(fanvueDmMessageReceipts.fanUuid, input.fanUuid),
      ),
    )
    .orderBy(asc(fanvueDmMessageReceipts.sentAt), asc(fanvueDmMessageReceipts.providerMessageUuid));
  let hasOpenInboundTurn = false;
  let logicalExchangeCount = 0;
  const activeDays = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.exchangeRole === 'inbound_turn') {
      hasOpenInboundTurn = true;
      continue;
    }
    if (receipt.exchangeRole !== 'outbound_root' || !hasOpenInboundTurn) continue;
    logicalExchangeCount += 1;
    activeDays.add(receipt.sentAt.toISOString().slice(0, 10));
    hasOpenInboundTurn = false;
  }
  await transaction
    .update(fanvueDmConversationState)
    .set({
      logicalExchangeCount,
      activeDayCount: activeDays.size,
      updatedAt: input.observedAt,
    })
    .where(
      and(
        eq(fanvueDmConversationState.workspaceId, input.workspaceId),
        eq(fanvueDmConversationState.accountId, input.accountId),
        eq(fanvueDmConversationState.fanUuid, input.fanUuid),
      ),
    );
}

async function historyExchangeRole(
  transaction: NodePgDatabase,
  input: z.output<typeof historyPage>,
  message: z.output<typeof historyMessage>,
) {
  if (message.direction === 'inbound') return 'inbound_turn' as const;
  const [groupPart] = await transaction
    .select({ sequenceIndex: fanvueDmPendingIntents.sequenceIndex })
    .from(fanvueActionIntents)
    .innerJoin(
      fanvueDmPendingIntents,
      and(
        eq(fanvueDmPendingIntents.workspaceId, fanvueActionIntents.workspaceId),
        eq(fanvueDmPendingIntents.accountId, fanvueActionIntents.accountId),
        eq(fanvueDmPendingIntents.clientActionId, fanvueActionIntents.clientActionId),
      ),
    )
    .where(
      and(
        eq(fanvueActionIntents.workspaceId, input.workspaceId),
        eq(fanvueActionIntents.accountId, input.accountId),
        eq(fanvueActionIntents.targetUuid, input.fanUuid),
        eq(fanvueActionIntents.providerObjectUuid, message.providerMessageUuid),
        isNotNull(fanvueDmPendingIntents.groupId),
      ),
    )
    .limit(1);
  if (groupPart?.sequenceIndex === 0) return 'outbound_root' as const;
  if (groupPart?.sequenceIndex !== null && groupPart?.sequenceIndex !== undefined)
    return 'outbound_tail' as const;
  return 'automation' as const;
}

async function recordHistoryMedia(
  transaction: NodePgDatabase,
  input: z.output<typeof historyPage>,
  message: z.output<typeof historyMessage>,
) {
  if (message.excludeMedia) return;
  for (const providerMediaUuid of [...new Set(message.mediaUuids)]) {
    const [existing] = await transaction
      .select()
      .from(fanvueDmMediaDeliveries)
      .where(
        and(
          eq(fanvueDmMediaDeliveries.workspaceId, input.workspaceId),
          eq(fanvueDmMediaDeliveries.accountId, input.accountId),
          eq(fanvueDmMediaDeliveries.fanUuid, input.fanUuid),
          eq(fanvueDmMediaDeliveries.providerMediaUuid, providerMediaUuid),
        ),
      )
      .for('update')
      .limit(1);
    if (existing) {
      if (!existing.providerMessageUuid)
        await transaction
          .update(fanvueDmMediaDeliveries)
          .set({
            state: 'confirmed',
            providerMessageUuid: message.providerMessageUuid,
            priceCents: message.priceCents,
            purchasedAt: message.purchasedAt,
            updatedAt: input.observedAt,
          })
          .where(eq(fanvueDmMediaDeliveries.id, existing.id));
      continue;
    }
    await transaction.insert(fanvueDmMediaDeliveries).values({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      fanUuid: input.fanUuid,
      providerMediaUuid,
      source: 'provider_history',
      providerMessageUuid: message.providerMessageUuid,
      state: 'confirmed',
      priceCents: message.priceCents,
      purchasedAt: message.purchasedAt,
      updatedAt: input.observedAt,
    });
  }
}

export async function ingestFanvueDmHistoryPage(
  database: NodePgDatabase,
  unparsed: z.input<typeof historyPage>,
) {
  const input = historyPage.parse(unparsed);
  return withTenantTransaction(database, input, async (transaction) => {
    await requireFanvueAccount(transaction, input);
    let oldestAt: Date | null = null;
    for (const message of input.messages) {
      const receiptInput = {
        ...input,
        ...message,
        exchangeRole: await historyExchangeRole(transaction, input, message),
        observedAt: input.observedAt,
      };
      await upsertMessageReceipt(transaction, receiptInput);
      await advanceReceiptBoundary(transaction, receiptInput);
      await recordHistoryMedia(transaction, input, message);
      if (!oldestAt || message.sentAt < oldestAt) oldestAt = message.sentAt;
    }
    if (input.messages[0])
      await refreshConversationCounts(transaction, {
        ...input,
        ...input.messages[0],
        exchangeRole: await historyExchangeRole(transaction, input, input.messages[0]),
        observedAt: input.observedAt,
      });
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
    const coverage =
      oldestAt &&
      (!existing?.historyCoverageOldestAt || oldestAt < existing.historyCoverageOldestAt)
        ? oldestAt
        : (existing?.historyCoverageOldestAt ?? null);
    const values = {
      historyCoverageOldestAt: coverage,
      historyBackfillCompleteAt: input.hasMore
        ? (existing?.historyBackfillCompleteAt ?? null)
        : input.observedAt,
      historyBackfillStatus: input.hasMore ? 'in_progress' : 'complete',
      historyBackfillFailureCode: null,
      historyBackfillLastAttemptAt: input.observedAt,
      updatedAt: input.observedAt,
    };
    if (existing)
      await transaction
        .update(fanvueDmConversationState)
        .set(values)
        .where(
          and(
            eq(fanvueDmConversationState.workspaceId, input.workspaceId),
            eq(fanvueDmConversationState.accountId, input.accountId),
            eq(fanvueDmConversationState.fanUuid, input.fanUuid),
          ),
        );
    else
      await transaction.insert(fanvueDmConversationState).values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        fanUuid: input.fanUuid,
        ...values,
      });
    return { ingested: input.messages.length, oldestAt: coverage, complete: !input.hasMore };
  });
}

export async function markFanvueDmHistoryBackfillIncomplete(
  database: NodePgDatabase,
  unparsed: z.input<typeof historyFailure>,
) {
  const input = historyFailure.parse(unparsed);
  return withTenantTransaction(database, input, async (transaction) => {
    await requireFanvueAccount(transaction, input);
    await transaction
      .insert(fanvueDmConversationState)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        fanUuid: input.fanUuid,
        historyBackfillStatus: 'incomplete',
        historyBackfillFailureCode: input.failureCode,
        historyBackfillLastAttemptAt: input.observedAt,
        updatedAt: input.observedAt,
      })
      .onConflictDoUpdate({
        target: [
          fanvueDmConversationState.workspaceId,
          fanvueDmConversationState.accountId,
          fanvueDmConversationState.fanUuid,
        ],
        set: {
          historyBackfillStatus: 'incomplete',
          historyBackfillFailureCode: input.failureCode,
          historyBackfillLastAttemptAt: input.observedAt,
          updatedAt: input.observedAt,
        },
      });
  });
}

export async function recordFanvueDmMessageReceipt(
  database: NodePgDatabase,
  unparsed: z.input<typeof messageReceipt>,
) {
  const input = messageReceipt.parse(unparsed);
  return withTenantTransaction(database, input, async (transaction) => {
    await requireFanvueAccount(transaction, input);
    const receipt = await upsertMessageReceipt(transaction, input);
    await advanceReceiptBoundary(transaction, input);
    await refreshConversationCounts(transaction, input);
    return receipt;
  });
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
    const directionalAt =
      input.latestDirection === 'inbound' ? existing?.latestInboundAt : existing?.latestOutboundAt;
    const directionalUuid =
      input.latestDirection === 'inbound'
        ? existing?.latestInboundMessageUuid
        : existing?.latestOutboundMessageUuid;
    if (directionalAt) {
      const isDirectionOlder = input.latestMessageAt.getTime() < directionalAt.getTime();
      const isDirectionAmbiguous =
        input.latestMessageAt.getTime() === directionalAt.getTime() &&
        input.latestMessageUuid !== directionalUuid;
      if ((isDirectionOlder || isDirectionAmbiguous) && existing) return existing;
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
