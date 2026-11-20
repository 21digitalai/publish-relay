import { createHash, randomInt, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { and, asc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  fanvueActionIntents,
  fanvueDmDispatchPacing,
  fanvueDmPendingIntents,
  fanvueCommentPendingIntents,
  engagementProposals,
  providerAccounts,
  providerConnections,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { lockFanvueActionNamespace } from './fanvue-action-namespace.js';
import {
  MessageGroupValidationError,
  sampleMessageGroupDueAt,
  validateMessageGroupBubbles,
} from '../engagement/message-group.js';

export const scheduleInput = z
  .strictObject({
    workspaceId: z.uuid(),
    accountId: z.uuid(),
    fanUuid: z.uuid(),
    clientActionId: z.uuid(),
    actor: z.strictObject({ type: z.enum(['user', 'api-key', 'delegated']), id: z.uuid() }),
    text: z.string().min(1).max(5000).optional(),
    targetLabel: z.string().min(1).max(160).nullable().optional(),
    mediaIds: z.array(z.uuid()).min(1).max(10).optional(),
    mediaPreviewId: z.uuid().optional(),
    price: z.number().int().min(300).optional(),
    dueAt: z.date(),
  })
  .superRefine((input, context) => {
    if (!input.text && !input.mediaIds?.length)
      context.addIssue({ code: 'custom', message: 'Text or media is required' });
    if (input.price !== undefined && !input.mediaIds?.length)
      context.addIssue({ code: 'custom', message: 'Priced messages require media' });
    if (input.mediaIds && new Set(input.mediaIds).size !== input.mediaIds.length)
      context.addIssue({ code: 'custom', message: 'Duplicate media is not allowed' });
    if (
      input.mediaPreviewId &&
      (input.price === undefined || !input.mediaIds?.includes(input.mediaPreviewId))
    )
      context.addIssue({ code: 'custom', message: 'Preview must be attached to priced media' });
  });

export class FanvueDmScheduleConflictError extends Error {
  constructor() {
    super('Scheduled Fanvue DM action ID conflicts with prior input');
  }
}

const projection = {
  id: fanvueDmPendingIntents.id,
  workspaceId: fanvueDmPendingIntents.workspaceId,
  accountId: fanvueDmPendingIntents.accountId,
  fanUuid: fanvueDmPendingIntents.fanUuid,
  clientActionId: fanvueDmPendingIntents.clientActionId,
  actorType: fanvueDmPendingIntents.actorType,
  actorId: fanvueDmPendingIntents.actorId,
  text: fanvueDmPendingIntents.textBody,
  targetLabel: fanvueDmPendingIntents.targetLabel,
  mediaIds: fanvueDmPendingIntents.mediaIds,
  mediaPreviewId: fanvueDmPendingIntents.mediaPreviewId,
  price: fanvueDmPendingIntents.priceCents,
  dueAt: fanvueDmPendingIntents.dueAt,
  status: fanvueDmPendingIntents.status,
  leaseOwner: fanvueDmPendingIntents.leaseOwner,
  groupId: fanvueDmPendingIntents.groupId,
  sequenceIndex: fanvueDmPendingIntents.sequenceIndex,
  gapSeconds: fanvueDmPendingIntents.gapSeconds,
  expectedLatestInboundMessageUuid: fanvueDmPendingIntents.expectedLatestInboundMessageUuid,
  expectedLatestInboundAt: fanvueDmPendingIntents.expectedLatestInboundAt,
};

export const fanvueGroupScheduleInput = z.strictObject({
  workspaceId: z.uuid(),
  accountId: z.uuid(),
  fanUuid: z.uuid(),
  clientActionId: z.uuid(),
  actor: z.strictObject({ type: z.enum(['user', 'api-key', 'delegated']), id: z.uuid() }),
  bubbles: z.array(z.string()).min(1).max(5),
  expectedLatestInboundMessageUuid: z.uuid(),
  expectedLatestInboundAt: z.date(),
  earliestAt: z.date(),
  latestAt: z.date(),
});

function groupFingerprint(input: z.output<typeof fanvueGroupScheduleInput>) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        accountId: input.accountId,
        fanUuid: input.fanUuid,
        actorType: input.actor.type === 'api-key' ? 'api_key' : input.actor.type,
        actorId: input.actor.id,
        bubbles: input.bubbles,
        expectedLatestInboundMessageUuid: input.expectedLatestInboundMessageUuid,
        expectedLatestInboundAt: input.expectedLatestInboundAt.toISOString(),
        earliestAt: input.earliestAt.toISOString(),
        latestAt: input.latestAt.toISOString(),
      }),
    )
    .digest('hex');
}

export async function scheduleFanvueDmGroup(
  database: NodePgDatabase,
  unparsed: z.input<typeof fanvueGroupScheduleInput>,
) {
  const input = fanvueGroupScheduleInput.parse(unparsed);
  try {
    validateMessageGroupBubbles(input.bubbles, {
      maximumBubbles: 5,
      maximumTextLength: 5_000,
    });
  } catch (error) {
    if (error instanceof MessageGroupValidationError) throw new FanvueDmScheduleConflictError();
    throw error;
  }
  return withTenantTransaction(database, input, async (tx) => {
    await lockFanvueActionNamespace(tx, input.workspaceId, input.clientActionId);
    const fingerprint = groupFingerprint(input);
    const [prior] = await tx
      .select(projection)
      .from(fanvueDmPendingIntents)
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    if (prior) {
      const [stored] = await tx
        .select({ requestFingerprint: fanvueDmPendingIntents.requestFingerprint })
        .from(fanvueDmPendingIntents)
        .where(eq(fanvueDmPendingIntents.id, prior.id))
        .limit(1);
      if (!prior.groupId || stored?.requestFingerprint !== fingerprint)
        throw new FanvueDmScheduleConflictError();
      return prior;
    }
    const [account] = await tx
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
    if (account?.provider !== 'fanvue') throw new FanvueDmScheduleConflictError();
    const [active] = await tx
      .select({ id: fanvueDmPendingIntents.id })
      .from(fanvueDmPendingIntents)
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.accountId, input.accountId),
          eq(fanvueDmPendingIntents.fanUuid, input.fanUuid),
          inArray(fanvueDmPendingIntents.status, ['waiting', 'pending', 'claimed', 'unknown']),
        ),
      )
      .limit(1);
    if (active) throw new FanvueDmScheduleConflictError();
    const groupId = randomUUID();
    const dueAt = sampleMessageGroupDueAt(input.earliestAt, input.latestAt);
    const actorType: 'user' | 'api_key' | 'delegated' =
      input.actor.type === 'api-key' ? 'api_key' : input.actor.type;
    const rows = input.bubbles.map((text, sequenceIndex) => ({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      fanUuid: input.fanUuid,
      clientActionId: sequenceIndex === 0 ? input.clientActionId : randomUUID(),
      actorType,
      actorId: input.actor.id,
      textBody: text,
      dueAt,
      groupId,
      sequenceIndex,
      gapSeconds: sequenceIndex === 0 ? 0 : randomInt(4, 11),
      expectedLatestInboundMessageUuid: input.expectedLatestInboundMessageUuid,
      expectedLatestInboundAt: input.expectedLatestInboundAt,
      requestFingerprint:
        sequenceIndex === 0
          ? fingerprint
          : createHash('sha256')
              .update(`${fingerprint}:${String(sequenceIndex)}`)
              .digest('hex'),
      status: sequenceIndex === 0 ? ('pending' as const) : ('waiting' as const),
    }));
    const inserted = await tx.insert(fanvueDmPendingIntents).values(rows).returning(projection);
    if (!inserted[0]) throw new Error('Fanvue DM group root insertion failed');
    return inserted[0];
  });
}

export async function getFanvueDmGroupStatus(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; fanUuid: string; clientActionId: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [root] = await tx
      .select({ groupId: fanvueDmPendingIntents.groupId, id: fanvueDmPendingIntents.id })
      .from(fanvueDmPendingIntents)
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.accountId, input.accountId),
          eq(fanvueDmPendingIntents.fanUuid, input.fanUuid),
          eq(fanvueDmPendingIntents.clientActionId, input.clientActionId),
          eq(fanvueDmPendingIntents.sequenceIndex, 0),
        ),
      )
      .limit(1);
    if (!root?.groupId) return null;
    const rows = await tx
      .select({
        sequence: fanvueDmPendingIntents.sequenceIndex,
        status: fanvueDmPendingIntents.status,
        dueAt: fanvueDmPendingIntents.dueAt,
      })
      .from(fanvueDmPendingIntents)
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.groupId, root.groupId),
        ),
      )
      .orderBy(asc(fanvueDmPendingIntents.sequenceIndex))
      .limit(5);
    return {
      id: root.id,
      bubbles: rows.map((row) => ({
        sequence: row.sequence,
        status: row.status,
        dueAt: row.dueAt.toISOString(),
      })),
    };
  });
}

export async function cancelFanvueDmGroup(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; fanUuid: string; clientActionId: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [root] = await tx
      .select({ groupId: fanvueDmPendingIntents.groupId })
      .from(fanvueDmPendingIntents)
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.accountId, input.accountId),
          eq(fanvueDmPendingIntents.fanUuid, input.fanUuid),
          eq(fanvueDmPendingIntents.clientActionId, input.clientActionId),
          eq(fanvueDmPendingIntents.sequenceIndex, 0),
        ),
      )
      .limit(1);
    if (!root?.groupId) return null;
    const cancelled = await tx
      .update(fanvueDmPendingIntents)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.groupId, root.groupId),
          inArray(fanvueDmPendingIntents.status, ['pending', 'waiting']),
        ),
      )
      .returning({ id: fanvueDmPendingIntents.id });
    return { cancelled: cancelled.length };
  });
}

function pendingFingerprint(value: {
  accountId: string;
  fanUuid: string;
  actorType: string;
  actorId: string;
  text: string | null;
  mediaIds: string[];
  mediaPreviewId: string | null;
  price: number | null;
  dueAt: Date;
}) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        accountId: value.accountId,
        fanUuid: value.fanUuid,
        actorType: value.actorType,
        actorId: value.actorId,
        text: value.text,
        mediaIds: value.mediaIds,
        mediaPreviewId: value.mediaPreviewId,
        price: value.price,
        dueAt: value.dueAt.toISOString(),
      }),
    )
    .digest('hex');
}

function expectedFingerprint(input: z.output<typeof scheduleInput>) {
  return pendingFingerprint({
    accountId: input.accountId,
    fanUuid: input.fanUuid,
    actorType: input.actor.type === 'api-key' ? 'api_key' : input.actor.type,
    actorId: input.actor.id,
    text: input.text ?? null,
    mediaIds: input.mediaIds ?? [],
    mediaPreviewId: input.mediaPreviewId ?? null,
    price: input.price ?? null,
    dueAt: input.dueAt,
  });
}

export async function replayScheduledFanvueDm(
  database: NodePgDatabase,
  unparsed: z.input<typeof scheduleInput>,
) {
  const input = scheduleInput.parse(unparsed);
  const prior = await findPendingFanvueDm(database, input);
  if (!prior) return null;
  if (pendingFingerprint(prior) !== expectedFingerprint(input))
    throw new FanvueDmScheduleConflictError();
  return prior;
}

/** Timing state only. The due worker must use the canonical FanvueMessageService sender. */
export async function scheduleFanvueDm(
  database: NodePgDatabase,
  unparsed: z.input<typeof scheduleInput>,
) {
  const input = scheduleInput.parse(unparsed);
  return withTenantTransaction(database, input, (tx) => insertScheduledFanvueDm(tx, input));
}

async function insertScheduledFanvueDm(tx: NodePgDatabase, input: z.output<typeof scheduleInput>) {
  await lockFanvueActionNamespace(tx, input.workspaceId, input.clientActionId);
  const [otherKind] = await tx
    .select({ id: fanvueCommentPendingIntents.id })
    .from(fanvueCommentPendingIntents)
    .where(
      and(
        eq(fanvueCommentPendingIntents.workspaceId, input.workspaceId),
        eq(fanvueCommentPendingIntents.clientActionId, input.clientActionId),
      ),
    )
    .limit(1);
  if (otherKind) throw new FanvueDmScheduleConflictError();
  const actorType = input.actor.type === 'api-key' ? 'api_key' : input.actor.type;
  const mediaIds = input.mediaIds ?? [];
  const fingerprint = expectedFingerprint(input);
  const [account] = await tx
    .select({ provider: providerAccounts.destinationProvider })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.workspaceId, input.workspaceId),
        eq(providerAccounts.id, input.accountId),
      ),
    )
    .limit(1);
  if (account?.provider !== 'fanvue') throw new FanvueDmScheduleConflictError();
  const [action] = await tx
    .select({ id: fanvueActionIntents.id })
    .from(fanvueActionIntents)
    .where(
      and(
        eq(fanvueActionIntents.workspaceId, input.workspaceId),
        eq(fanvueActionIntents.clientActionId, input.clientActionId),
      ),
    )
    .limit(1);
  if (action) throw new FanvueDmScheduleConflictError();
  const [inserted] = await tx
    .insert(fanvueDmPendingIntents)
    .values({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      fanUuid: input.fanUuid,
      clientActionId: input.clientActionId,
      actorType,
      actorId: input.actor.id,
      textBody: input.text ?? null,
      targetLabel: input.targetLabel ?? null,
      mediaIds,
      mediaPreviewId: input.mediaPreviewId ?? null,
      priceCents: input.price ?? null,
      dueAt: input.dueAt,
    })
    .onConflictDoNothing()
    .returning(projection);
  if (inserted) return inserted;
  const [existing] = await tx
    .select(projection)
    .from(fanvueDmPendingIntents)
    .where(
      and(
        eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
        eq(fanvueDmPendingIntents.clientActionId, input.clientActionId),
      ),
    )
    .limit(1);
  if (!existing) throw new FanvueDmScheduleConflictError();
  const same = pendingFingerprint(existing) === fingerprint;
  if (!same) throw new FanvueDmScheduleConflictError();
  return existing;
}

/** Approval and immutable timing intent commit together; no provider send occurs here. */
export async function scheduleApprovedFanvueDm(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    proposalId: string;
    expectedRevision: number;
    userId: string;
    accountId: string;
    fanUuid: string;
    clientActionId: string;
    content: unknown;
    text: string;
    mediaIds?: string[];
    price?: number;
    targetLabel: string | null;
  },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [selected] = await tx
      .select({
        proposal: engagementProposals,
        availability: providerAccounts.availability,
        disconnectedAt: providerAccounts.disconnectedAt,
        connectionStatus: providerConnections.status,
        revokedAt: providerConnections.revokedAt,
      })
      .from(engagementProposals)
      .innerJoin(
        providerAccounts,
        and(
          eq(providerAccounts.workspaceId, engagementProposals.workspaceId),
          eq(providerAccounts.id, engagementProposals.accountId),
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
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.proposalId),
        ),
      )
      .for('update')
      .limit(1);
    if (!selected) throw new FanvueDmScheduleConflictError();
    const proposal = selected.proposal;
    if (
      proposal.status !== 'pending' ||
      proposal.revision !== input.expectedRevision ||
      proposal.provider !== 'fanvue' ||
      proposal.kind !== 'dm' ||
      proposal.accountId !== input.accountId ||
      proposal.targetId !== input.fanUuid ||
      proposal.clientActionId !== input.clientActionId ||
      !isDeepStrictEqual(proposal.content, input.content)
    )
      throw new FanvueDmScheduleConflictError();
    if (
      selected.availability !== 'active' ||
      selected.disconnectedAt ||
      selected.connectionStatus !== 'active' ||
      selected.revokedAt
    )
      throw new FanvueDmScheduleConflictError();
    const now = new Date();
    const dueAt =
      proposal.plannedDueAt && proposal.plannedDueAt > now ? proposal.plannedDueAt : now;
    const intent = await insertScheduledFanvueDm(
      tx,
      scheduleInput.parse({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        fanUuid: input.fanUuid,
        clientActionId: input.clientActionId,
        actor: { type: 'user', id: input.userId },
        text: input.text,
        targetLabel: input.targetLabel,
        ...(input.mediaIds ? { mediaIds: input.mediaIds } : {}),
        ...(input.price !== undefined ? { price: input.price } : {}),
        dueAt,
      }),
    );
    await tx
      .update(engagementProposals)
      .set({ status: 'scheduled', updatedAt: now })
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.proposalId),
        ),
      );
    return { id: proposal.id, status: 'scheduled' as const, dueAt: intent.dueAt.toISOString() };
  });
}

export async function cancelPendingFanvueDm(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; fanUuid: string; clientActionId: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [cancelled] = await tx
      .update(fanvueDmPendingIntents)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.accountId, input.accountId),
          eq(fanvueDmPendingIntents.fanUuid, input.fanUuid),
          eq(fanvueDmPendingIntents.clientActionId, input.clientActionId),
          eq(fanvueDmPendingIntents.status, 'pending'),
        ),
      )
      .returning({ id: fanvueDmPendingIntents.id });
    if (cancelled) {
      await tx
        .update(engagementProposals)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(
          and(
            eq(engagementProposals.workspaceId, input.workspaceId),
            eq(engagementProposals.clientActionId, input.clientActionId),
            eq(engagementProposals.provider, 'fanvue'),
            eq(engagementProposals.kind, 'dm'),
            eq(engagementProposals.status, 'scheduled'),
          ),
        );
    }
    return Boolean(cancelled);
  });
}

export async function cancelScheduledProposalFanvueDm(
  database: NodePgDatabase,
  input: { workspaceId: string; proposalId: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [proposal] = await tx
      .select({
        id: engagementProposals.id,
        clientActionId: engagementProposals.clientActionId,
      })
      .from(engagementProposals)
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.proposalId),
          eq(engagementProposals.provider, 'fanvue'),
          eq(engagementProposals.kind, 'dm'),
          eq(engagementProposals.status, 'scheduled'),
        ),
      )
      .limit(1);
    if (!proposal) return false;
    const [cancelled] = await tx
      .update(fanvueDmPendingIntents)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.clientActionId, proposal.clientActionId),
          eq(fanvueDmPendingIntents.status, 'pending'),
        ),
      )
      .returning({ id: fanvueDmPendingIntents.id });
    if (!cancelled) return false;
    await tx
      .update(engagementProposals)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, proposal.id),
        ),
      );
    return true;
  });
}

export async function findPendingFanvueDm(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; fanUuid: string; clientActionId: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [intent] = await tx
      .select(projection)
      .from(fanvueDmPendingIntents)
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.accountId, input.accountId),
          eq(fanvueDmPendingIntents.fanUuid, input.fanUuid),
          eq(fanvueDmPendingIntents.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    return intent ?? null;
  });
}

/** Worker BYPASSRLS is used only to choose a due row; the account lock serializes pacing. */
export async function claimDueFanvueDm(
  database: NodePgDatabase,
  input: { workerId: string; now: Date; leaseMs: number },
) {
  return database.transaction(async (tx) => {
    const [candidate] = await tx
      .select({
        id: fanvueDmPendingIntents.id,
        workspaceId: fanvueDmPendingIntents.workspaceId,
        accountId: fanvueDmPendingIntents.accountId,
        sequenceIndex: fanvueDmPendingIntents.sequenceIndex,
      })
      .from(fanvueDmPendingIntents)
      .leftJoin(
        fanvueDmDispatchPacing,
        and(
          eq(fanvueDmDispatchPacing.workspaceId, fanvueDmPendingIntents.workspaceId),
          eq(fanvueDmDispatchPacing.accountId, fanvueDmPendingIntents.accountId),
        ),
      )
      .where(
        and(
          lte(fanvueDmPendingIntents.dueAt, input.now),
          or(
            gt(fanvueDmPendingIntents.sequenceIndex, 0),
            isNull(fanvueDmDispatchPacing.accountId),
            lte(fanvueDmDispatchPacing.nextAt, input.now),
          ),
          or(
            eq(fanvueDmPendingIntents.status, 'pending'),
            and(
              eq(fanvueDmPendingIntents.status, 'claimed'),
              lte(fanvueDmPendingIntents.leaseUntil, input.now),
            ),
          ),
        ),
      )
      .orderBy(fanvueDmPendingIntents.dueAt, fanvueDmPendingIntents.id)
      .limit(1);
    if (!candidate) return null;
    const [account] = await tx
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.workspaceId, candidate.workspaceId),
          eq(providerAccounts.id, candidate.accountId),
        ),
      )
      .limit(1)
      .for('update', { skipLocked: true });
    if (!account) return null;
    const [pacing] = await tx
      .select({ nextAt: fanvueDmDispatchPacing.nextAt })
      .from(fanvueDmDispatchPacing)
      .where(
        and(
          eq(fanvueDmDispatchPacing.workspaceId, candidate.workspaceId),
          eq(fanvueDmDispatchPacing.accountId, candidate.accountId),
        ),
      )
      .limit(1);
    if (candidate.sequenceIndex === 0 || candidate.sequenceIndex === null) {
      if (pacing && pacing.nextAt > input.now) return null;
    }
    const [claimed] = await tx
      .update(fanvueDmPendingIntents)
      .set({
        status: 'claimed',
        leaseOwner: `${input.workerId}:${randomUUID()}`,
        leaseUntil: new Date(input.now.getTime() + input.leaseMs),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(fanvueDmPendingIntents.id, candidate.id),
          lte(fanvueDmPendingIntents.dueAt, input.now),
          or(
            eq(fanvueDmPendingIntents.status, 'pending'),
            and(
              eq(fanvueDmPendingIntents.status, 'claimed'),
              lte(fanvueDmPendingIntents.leaseUntil, input.now),
            ),
          ),
        ),
      )
      .returning(projection);
    if (!claimed) return null;
    await tx
      .update(engagementProposals)
      .set({ status: 'sending', updatedAt: input.now })
      .where(
        and(
          eq(engagementProposals.workspaceId, candidate.workspaceId),
          eq(engagementProposals.clientActionId, claimed.clientActionId),
          eq(engagementProposals.provider, 'fanvue'),
          eq(engagementProposals.kind, 'dm'),
          eq(engagementProposals.status, 'scheduled'),
        ),
      );
    if (candidate.sequenceIndex === 0 || candidate.sequenceIndex === null) {
      const nextAt = new Date(input.now.getTime() + randomInt(60, 121) * 1000);
      await tx
        .insert(fanvueDmDispatchPacing)
        .values({ workspaceId: candidate.workspaceId, accountId: candidate.accountId, nextAt })
        .onConflictDoUpdate({
          target: [fanvueDmDispatchPacing.workspaceId, fanvueDmDispatchPacing.accountId],
          set: { nextAt },
        });
    }
    return claimed;
  });
}

export async function renewClaimedFanvueDm(
  database: NodePgDatabase,
  input: { workspaceId: string; id: string; leaseOwner: string; leaseMs: number },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [renewed] = await tx
      .update(fanvueDmPendingIntents)
      .set({ leaseUntil: new Date(Date.now() + input.leaseMs), updatedAt: new Date() })
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.id, input.id),
          eq(fanvueDmPendingIntents.status, 'claimed'),
          eq(fanvueDmPendingIntents.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({ id: fanvueDmPendingIntents.id });
    return Boolean(renewed);
  });
}

/** A pre-reservation failure may retry; a durable action must never be sent again. */
export async function finishClaimedFanvueDm(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    id: string;
    leaseOwner: string;
    state: 'confirmed' | 'failed' | 'unknown' | 'pending';
  },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [intent] = await tx
      .select({
        clientActionId: fanvueDmPendingIntents.clientActionId,
        groupId: fanvueDmPendingIntents.groupId,
        sequenceIndex: fanvueDmPendingIntents.sequenceIndex,
      })
      .from(fanvueDmPendingIntents)
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.id, input.id),
          eq(fanvueDmPendingIntents.status, 'claimed'),
          eq(fanvueDmPendingIntents.leaseOwner, input.leaseOwner),
        ),
      )
      .for('update');
    if (!intent) return false;
    if (input.state === 'pending') {
      const [action] = await tx
        .select({ id: fanvueActionIntents.id })
        .from(fanvueActionIntents)
        .where(
          and(
            eq(fanvueActionIntents.workspaceId, input.workspaceId),
            eq(fanvueActionIntents.clientActionId, intent.clientActionId),
          ),
        )
        .limit(1);
      if (action) throw new Error('Cannot retry Fanvue DM after action reservation');
    }
    const [settled] = await tx
      .update(fanvueDmPendingIntents)
      .set({
        status: input.state,
        leaseOwner: null,
        leaseUntil: null,
        // Preserve the original planned time; the per-account pacing cursor bounds retries.
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
          eq(fanvueDmPendingIntents.id, input.id),
          eq(fanvueDmPendingIntents.status, 'claimed'),
          eq(fanvueDmPendingIntents.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({ id: fanvueDmPendingIntents.id });
    if (settled) {
      if (intent.groupId && intent.sequenceIndex !== null) {
        if (input.state === 'confirmed') {
          const [next] = await tx
            .select({
              id: fanvueDmPendingIntents.id,
              gapSeconds: fanvueDmPendingIntents.gapSeconds,
            })
            .from(fanvueDmPendingIntents)
            .where(
              and(
                eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
                eq(fanvueDmPendingIntents.groupId, intent.groupId),
                eq(fanvueDmPendingIntents.sequenceIndex, intent.sequenceIndex + 1),
                eq(fanvueDmPendingIntents.status, 'waiting'),
              ),
            )
            .limit(1);
          if (next) {
            await tx
              .update(fanvueDmPendingIntents)
              .set({
                status: 'pending',
                dueAt: new Date(Date.now() + (next.gapSeconds ?? 0) * 1_000),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
                  eq(fanvueDmPendingIntents.id, next.id),
                  eq(fanvueDmPendingIntents.status, 'waiting'),
                ),
              );
          }
        } else if (input.state === 'failed') {
          await tx
            .update(fanvueDmPendingIntents)
            .set({ status: 'cancelled', updatedAt: new Date() })
            .where(
              and(
                eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
                eq(fanvueDmPendingIntents.groupId, intent.groupId),
                eq(fanvueDmPendingIntents.status, 'waiting'),
              ),
            );
        }
      }
      const proposalStatus =
        input.state === 'confirmed'
          ? 'sent'
          : input.state === 'pending'
            ? 'scheduled'
            : input.state;
      await tx
        .update(engagementProposals)
        .set({ status: proposalStatus, updatedAt: new Date() })
        .where(
          and(
            eq(engagementProposals.workspaceId, input.workspaceId),
            eq(engagementProposals.clientActionId, intent.clientActionId),
            eq(engagementProposals.provider, 'fanvue'),
            eq(engagementProposals.kind, 'dm'),
            eq(engagementProposals.status, 'sending'),
          ),
        );
    }
    return Boolean(settled);
  });
}
