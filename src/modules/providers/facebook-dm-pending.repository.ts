import { createHash, randomUUID } from 'node:crypto';

import { and, eq, inArray, lte, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  engagementProposals,
  facebookPageDmActions,
  facebookPageDmDelaySettings,
  facebookPageDmPendingIntents,
  providerAccounts,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  isPageConversationNoGoInTransaction,
  lockPageDmAccount,
} from './facebook-dm-no-go.repository.js';

export interface PendingDmInput {
  workspaceId: string;
  accountId: string;
  conversationId: string;
  clientActionId: string;
  requestFingerprint: string;
  actor: { type: 'user' | 'api-key' | 'delegated'; id: string };
  text: string;
  dueAt: Date;
}

export class PendingDmConflictError extends Error {
  constructor(message = 'Scheduled Page message action ID conflicts with a prior request') {
    super(message);
  }
}

export class PendingDmNoGoError extends Error {
  constructor() {
    super('This Page conversation is on the no-go list');
  }
}

export async function getPageDmDelayWindow(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
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
    if (account?.provider !== 'facebook_page') return null;
    const [settings] = await tx
      .select({
        earliestDelaySeconds: facebookPageDmDelaySettings.earliestDelaySeconds,
        latestDelaySeconds: facebookPageDmDelaySettings.latestDelaySeconds,
      })
      .from(facebookPageDmDelaySettings)
      .where(
        and(
          eq(facebookPageDmDelaySettings.workspaceId, input.workspaceId),
          eq(facebookPageDmDelaySettings.accountId, input.accountId),
        ),
      )
      .limit(1);
    return settings ?? { earliestDelaySeconds: 300, latestDelaySeconds: 2700 };
  });
}

export async function setPageDmDelayWindow(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    accountId: string;
    earliestDelaySeconds: number;
    latestDelaySeconds: number;
  },
) {
  if (
    !Number.isInteger(input.earliestDelaySeconds) ||
    !Number.isInteger(input.latestDelaySeconds) ||
    input.earliestDelaySeconds < 0 ||
    input.latestDelaySeconds > 82_800 ||
    input.latestDelaySeconds < input.earliestDelaySeconds
  )
    throw new PendingDmConflictError();
  return withTenantTransaction(database, input, async (tx) => {
    await lockPageDmAccount(tx, input);
    await tx
      .insert(facebookPageDmDelaySettings)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        earliestDelaySeconds: input.earliestDelaySeconds,
        latestDelaySeconds: input.latestDelaySeconds,
      })
      .onConflictDoUpdate({
        target: [facebookPageDmDelaySettings.workspaceId, facebookPageDmDelaySettings.accountId],
        set: {
          earliestDelaySeconds: input.earliestDelaySeconds,
          latestDelaySeconds: input.latestDelaySeconds,
        },
      });
    return {
      earliestDelaySeconds: input.earliestDelaySeconds,
      latestDelaySeconds: input.latestDelaySeconds,
    };
  });
}

const projection = {
  id: facebookPageDmPendingIntents.id,
  workspaceId: facebookPageDmPendingIntents.workspaceId,
  accountId: facebookPageDmPendingIntents.accountId,
  conversationId: facebookPageDmPendingIntents.conversationId,
  clientActionId: facebookPageDmPendingIntents.clientActionId,
  requestFingerprint: facebookPageDmPendingIntents.requestFingerprint,
  actorType: facebookPageDmPendingIntents.actorType,
  actorId: facebookPageDmPendingIntents.actorId,
  text: facebookPageDmPendingIntents.textBody,
  dueAt: facebookPageDmPendingIntents.dueAt,
  preSendAttempts: facebookPageDmPendingIntents.preSendAttempts,
  status: facebookPageDmPendingIntents.status,
  groupId: facebookPageDmPendingIntents.groupId,
  sequenceIndex: facebookPageDmPendingIntents.sequenceIndex,
  expectedLatestInboundMessageId: facebookPageDmPendingIntents.expectedLatestInboundMessageId,
  leaseOwner: facebookPageDmPendingIntents.leaseOwner,
};

/** Schedule once. The action ID remains the provider idempotency key at dispatch. */
async function schedulePageDmInTransaction(tx: NodePgDatabase, input: PendingDmInput) {
  await lockPageDmAccount(tx, input);
  if (await isPageConversationNoGoInTransaction(tx, input)) throw new PendingDmNoGoError();
  const [sent] = await tx
    .select({ id: facebookPageDmActions.id })
    .from(facebookPageDmActions)
    .where(
      and(
        eq(facebookPageDmActions.workspaceId, input.workspaceId),
        eq(facebookPageDmActions.clientActionId, input.clientActionId),
      ),
    )
    .limit(1);
  if (sent) throw new PendingDmConflictError();
  const actorType = input.actor.type === 'api-key' ? 'api_key' : input.actor.type;
  const [inserted] = await tx
    .insert(facebookPageDmPendingIntents)
    .values({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      clientActionId: input.clientActionId,
      requestFingerprint: input.requestFingerprint,
      actorType,
      actorId: input.actor.id,
      textBody: input.text,
      dueAt: input.dueAt,
    })
    .onConflictDoNothing()
    .returning(projection);
  if (inserted) return inserted;
  const [existing] = await tx
    .select(projection)
    .from(facebookPageDmPendingIntents)
    .where(
      and(
        eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
        eq(facebookPageDmPendingIntents.clientActionId, input.clientActionId),
      ),
    )
    .limit(1);
  if (
    existing?.accountId !== input.accountId ||
    existing.conversationId !== input.conversationId ||
    existing.requestFingerprint !== input.requestFingerprint ||
    existing.actorType !== actorType ||
    existing.actorId !== input.actor.id ||
    existing.text !== input.text
  )
    throw new PendingDmConflictError();
  return existing;
}

export async function schedulePageDm(database: NodePgDatabase, input: PendingDmInput) {
  return withTenantTransaction(database, input, (tx) => schedulePageDmInTransaction(tx, input));
}

const proposalTextSchema = z.strictObject({
  text: z.string().trim().min(1).max(2000),
  followUps: z
    .tuple([z.string().trim().min(1).max(2000), z.string().trim().min(1).max(2000)])
    .optional(),
});

/** One approval atomically arms one exact Page DM revision instead of sending now. */
export async function scheduleApprovedPageDm(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    userId: string;
    proposalId: string;
    expectedRevision: number;
  },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [preliminary] = await tx
      .select({ accountId: engagementProposals.accountId })
      .from(engagementProposals)
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.proposalId),
        ),
      )
      .limit(1);
    if (!preliminary) throw new PendingDmConflictError();
    await lockPageDmAccount(tx, {
      workspaceId: input.workspaceId,
      accountId: preliminary.accountId,
    });
    const [proposal] = await tx
      .select()
      .from(engagementProposals)
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.proposalId),
        ),
      )
      .limit(1)
      .for('update');
    const content = proposalTextSchema.safeParse(proposal?.content);
    if (!proposal) throw new PendingDmConflictError();
    if (
      proposal.status !== 'pending' ||
      proposal.revision !== input.expectedRevision ||
      proposal.provider !== 'facebook_page' ||
      proposal.kind !== 'dm' ||
      !/^[A-Za-z0-9_]{1,200}$/.test(proposal.targetId) ||
      !content.success
    )
      throw new PendingDmConflictError();
    if (!proposal.plannedDueAt || proposal.plannedDueAt.getTime() <= Date.now())
      throw new PendingDmConflictError(
        'Bot-selected send time is missing or has passed; request a new proposal',
      );
    const source = z
      .object({ sourceMessageId: z.string().min(1).max(256).optional() })
      .safeParse(proposal.sourceContext);
    if (content.data.followUps && (!source.success || !source.data.sourceMessageId))
      throw new PendingDmConflictError(
        'Grouped reply requires the reviewed latest inbound message ID',
      );
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          proposalId: proposal.id,
          revision: proposal.revision,
          text: content.data.text,
          plannedDueAt: proposal.plannedDueAt.toISOString(),
        }),
      )
      .digest('hex');
    const intent = await schedulePageDmInTransaction(tx, {
      workspaceId: input.workspaceId,
      accountId: proposal.accountId,
      conversationId: proposal.targetId,
      clientActionId: proposal.clientActionId,
      requestFingerprint: fingerprint,
      actor: { type: 'user', id: input.userId },
      text: content.data.text,
      dueAt: proposal.plannedDueAt,
    });
    if (content.data.followUps) {
      await tx
        .update(facebookPageDmPendingIntents)
        .set({
          groupId: proposal.id,
          sequenceIndex: 0,
          gapSeconds: 0,
          expectedLatestInboundMessageId: source.success ? source.data.sourceMessageId : null,
        })
        .where(eq(facebookPageDmPendingIntents.id, intent.id));
      for (const [index, text] of content.data.followUps.entries()) {
        await tx.insert(facebookPageDmPendingIntents).values({
          workspaceId: input.workspaceId,
          accountId: proposal.accountId,
          conversationId: proposal.targetId,
          clientActionId: randomUUID(),
          requestFingerprint: createHash('sha256')
            .update(
              JSON.stringify({
                proposalId: proposal.id,
                revision: proposal.revision,
                sequenceIndex: index + 1,
                text,
              }),
            )
            .digest('hex'),
          actorType: 'user',
          actorId: input.userId,
          textBody: text,
          dueAt: proposal.plannedDueAt,
          groupId: proposal.id,
          sequenceIndex: index + 1,
          gapSeconds: 4 + Math.floor(Math.random() * 7),
          expectedLatestInboundMessageId: source.success ? source.data.sourceMessageId : null,
          status: 'waiting',
        });
      }
    }
    await tx
      .update(engagementProposals)
      .set({ status: 'scheduled', updatedAt: new Date() })
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, proposal.id),
        ),
      );
    return { id: proposal.id, status: 'scheduled' as const, dueAt: intent.dueAt };
  });
}

/** Cancellation wins only before a worker claims this intent. */
export async function cancelPendingPageDm(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; conversationId: string; id: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [row] = await tx
      .update(facebookPageDmPendingIntents)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageDmPendingIntents.accountId, input.accountId),
          eq(facebookPageDmPendingIntents.conversationId, input.conversationId),
          eq(facebookPageDmPendingIntents.id, input.id),
          eq(facebookPageDmPendingIntents.status, 'pending'),
        ),
      )
      .returning({
        id: facebookPageDmPendingIntents.id,
        clientActionId: facebookPageDmPendingIntents.clientActionId,
      });
    if (row)
      await tx
        .update(engagementProposals)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(
          and(
            eq(engagementProposals.workspaceId, input.workspaceId),
            eq(engagementProposals.clientActionId, row.clientActionId),
            eq(engagementProposals.status, 'scheduled'),
          ),
        );
    return Boolean(row);
  });
}

/** Browser cancellation resolves the exact proposal; no raw intent or recipient ID is needed. */
export async function cancelScheduledProposalPageDm(
  database: NodePgDatabase,
  input: { workspaceId: string; proposalId: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [proposal] = await tx
      .select({
        id: engagementProposals.id,
        accountId: engagementProposals.accountId,
        conversationId: engagementProposals.targetId,
        clientActionId: engagementProposals.clientActionId,
        status: engagementProposals.status,
      })
      .from(engagementProposals)
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.proposalId),
          eq(engagementProposals.provider, 'facebook_page'),
          eq(engagementProposals.kind, 'dm'),
        ),
      )
      .limit(1);
    if (proposal?.status !== 'scheduled') return false;
    const groupRows = await tx
      .select({ status: facebookPageDmPendingIntents.status })
      .from(facebookPageDmPendingIntents)
      .where(
        and(
          eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageDmPendingIntents.groupId, proposal.id),
        ),
      )
      .for('update');
    if (groupRows.some((row) => row.status === 'claimed')) return false;
    const intents = await tx
      .update(facebookPageDmPendingIntents)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageDmPendingIntents.accountId, proposal.accountId),
          eq(facebookPageDmPendingIntents.conversationId, proposal.conversationId),
          or(
            eq(facebookPageDmPendingIntents.clientActionId, proposal.clientActionId),
            eq(facebookPageDmPendingIntents.groupId, proposal.id),
          ),
          inArray(facebookPageDmPendingIntents.status, ['pending', 'waiting']),
        ),
      )
      .returning({ id: facebookPageDmPendingIntents.id });
    if (!intents.length) return false;
    await tx
      .update(engagementProposals)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.proposalId),
          eq(engagementProposals.status, 'scheduled'),
        ),
      );
    return true;
  });
}

export async function getScheduledProposalPageDm(
  database: NodePgDatabase,
  input: { workspaceId: string; clientActionId: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [intent] = await tx
      .select({
        dueAt: facebookPageDmPendingIntents.dueAt,
        status: facebookPageDmPendingIntents.status,
        groupId: facebookPageDmPendingIntents.groupId,
      })
      .from(facebookPageDmPendingIntents)
      .where(
        and(
          eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageDmPendingIntents.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    if (!intent) return null;
    if (intent.groupId) {
      const [next] = await tx
        .select({
          dueAt: facebookPageDmPendingIntents.dueAt,
          status: facebookPageDmPendingIntents.status,
        })
        .from(facebookPageDmPendingIntents)
        .where(
          and(
            eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
            eq(facebookPageDmPendingIntents.groupId, intent.groupId),
            inArray(facebookPageDmPendingIntents.status, ['pending', 'waiting', 'claimed']),
          ),
        )
        .orderBy(facebookPageDmPendingIntents.sequenceIndex)
        .limit(1);
      if (next)
        return {
          dueAt: next.dueAt.toISOString(),
          status: next.status === 'waiting' ? 'pending' : next.status,
        };
    }
    return { dueAt: intent.dueAt.toISOString(), status: intent.status };
  });
}

export async function hasPendingPageDmAction(
  database: NodePgDatabase,
  input: { workspaceId: string; clientActionId: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [row] = await tx
      .select({ id: facebookPageDmPendingIntents.id })
      .from(facebookPageDmPendingIntents)
      .where(
        and(
          eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageDmPendingIntents.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    return Boolean(row);
  });
}

/** Worker has BYPASSRLS; each claimed row is subsequently handled in tenant context. */
export async function claimDuePageDms(
  database: NodePgDatabase,
  input: { workerId: string; now: Date; leaseMs: number; limit: number },
) {
  return database.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: facebookPageDmPendingIntents.id })
      .from(facebookPageDmPendingIntents)
      .where(
        and(
          lte(facebookPageDmPendingIntents.dueAt, input.now),
          or(
            eq(facebookPageDmPendingIntents.status, 'pending'),
            and(
              eq(facebookPageDmPendingIntents.status, 'claimed'),
              lte(facebookPageDmPendingIntents.leaseUntil, input.now),
            ),
          ),
        ),
      )
      .orderBy(facebookPageDmPendingIntents.dueAt, facebookPageDmPendingIntents.id)
      .limit(input.limit)
      .for('update', { skipLocked: true });
    if (!candidates.length) return [];
    return tx
      .update(facebookPageDmPendingIntents)
      .set({
        status: 'claimed',
        leaseOwner: `${input.workerId}:${randomUUID()}`,
        leaseUntil: new Date(input.now.getTime() + input.leaseMs),
        updatedAt: input.now,
      })
      .where(
        inArray(
          facebookPageDmPendingIntents.id,
          candidates.map((row) => row.id),
        ),
      )
      .returning(projection);
  });
}

/** Keep an active provider call owned while it exceeds the initial lease. */
export async function renewClaimedPageDm(
  database: NodePgDatabase,
  input: { workspaceId: string; id: string; workerId: string; leaseMs: number },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [renewed] = await tx
      .update(facebookPageDmPendingIntents)
      .set({ leaseUntil: new Date(Date.now() + input.leaseMs), updatedAt: new Date() })
      .where(
        and(
          eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageDmPendingIntents.id, input.id),
          eq(facebookPageDmPendingIntents.status, 'claimed'),
          eq(facebookPageDmPendingIntents.leaseOwner, input.workerId),
        ),
      )
      .returning({ id: facebookPageDmPendingIntents.id });
    return Boolean(renewed);
  });
}

/** A released lease is retryable only if the provider action ledger was never reserved. */
export async function finishClaimedPageDm(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    id: string;
    workerId: string;
    state: 'confirmed' | 'failed' | 'unknown' | 'pending';
  },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [intent] = await tx
      .select({
        clientActionId: facebookPageDmPendingIntents.clientActionId,
        preSendAttempts: facebookPageDmPendingIntents.preSendAttempts,
        groupId: facebookPageDmPendingIntents.groupId,
        sequenceIndex: facebookPageDmPendingIntents.sequenceIndex,
      })
      .from(facebookPageDmPendingIntents)
      .where(
        and(
          eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageDmPendingIntents.id, input.id),
          eq(facebookPageDmPendingIntents.status, 'claimed'),
          eq(facebookPageDmPendingIntents.leaseOwner, input.workerId),
        ),
      )
      .for('update');
    if (!intent) return false;
    if (input.state === 'pending') {
      const [action] = await tx
        .select({ id: facebookPageDmActions.id })
        .from(facebookPageDmActions)
        .where(
          and(
            eq(facebookPageDmActions.workspaceId, input.workspaceId),
            eq(facebookPageDmActions.clientActionId, intent.clientActionId),
          ),
        )
        .limit(1);
      if (action) throw new Error('Cannot retry a Page DM with a reserved provider action');
    }
    const attempts = intent.preSendAttempts + (input.state === 'pending' ? 1 : 0);
    const state = input.state === 'pending' && attempts >= 3 ? 'failed' : input.state;
    await tx
      .update(facebookPageDmPendingIntents)
      .set({
        status: state,
        preSendAttempts: attempts,
        ...(state === 'pending'
          ? { dueAt: new Date(Date.now() + 30_000 * 2 ** (attempts - 1)) }
          : {}),
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(facebookPageDmPendingIntents.id, input.id));
    if (
      state === 'confirmed' &&
      intent.groupId &&
      intent.sequenceIndex !== null &&
      intent.sequenceIndex < 2
    ) {
      const [next] = await tx
        .update(facebookPageDmPendingIntents)
        .set({
          status: 'pending',
          dueAt: new Date(
            Date.now() +
              (await getGroupGapSeconds(
                tx,
                input.workspaceId,
                intent.groupId,
                intent.sequenceIndex + 1,
              )) *
                1000,
          ),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
            eq(facebookPageDmPendingIntents.groupId, intent.groupId),
            eq(facebookPageDmPendingIntents.sequenceIndex, intent.sequenceIndex + 1),
            eq(facebookPageDmPendingIntents.status, 'waiting'),
          ),
        )
        .returning({ id: facebookPageDmPendingIntents.id });
      if (!next) {
        const [stopped] = await tx
          .select({ status: facebookPageDmPendingIntents.status })
          .from(facebookPageDmPendingIntents)
          .where(
            and(
              eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
              eq(facebookPageDmPendingIntents.groupId, intent.groupId),
              eq(facebookPageDmPendingIntents.sequenceIndex, intent.sequenceIndex + 1),
            ),
          )
          .limit(1);
        if (stopped?.status !== 'cancelled')
          throw new Error('Grouped Page DM next bubble is not waiting');
      }
    }
    if (state !== 'pending' && state !== 'confirmed' && intent.groupId)
      await tx
        .update(facebookPageDmPendingIntents)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(
          and(
            eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
            eq(facebookPageDmPendingIntents.groupId, intent.groupId),
            eq(facebookPageDmPendingIntents.status, 'waiting'),
          ),
        );
    if (
      state !== 'pending' &&
      (!intent.groupId || state !== 'confirmed' || intent.sequenceIndex === 2)
    )
      await tx
        .update(engagementProposals)
        .set({ status: state === 'confirmed' ? 'sent' : state, updatedAt: new Date() })
        .where(
          and(
            eq(engagementProposals.workspaceId, input.workspaceId),
            or(
              eq(engagementProposals.clientActionId, intent.clientActionId),
              ...(intent.groupId ? [eq(engagementProposals.id, intent.groupId)] : []),
            ),
            eq(engagementProposals.status, 'scheduled'),
          ),
        );
    return true;
  });
}

async function getGroupGapSeconds(
  tx: NodePgDatabase,
  workspaceId: string,
  groupId: string,
  sequenceIndex: number,
) {
  const [next] = await tx
    .select({ gapSeconds: facebookPageDmPendingIntents.gapSeconds })
    .from(facebookPageDmPendingIntents)
    .where(
      and(
        eq(facebookPageDmPendingIntents.workspaceId, workspaceId),
        eq(facebookPageDmPendingIntents.groupId, groupId),
        eq(facebookPageDmPendingIntents.sequenceIndex, sequenceIndex),
      ),
    )
    .limit(1);
  if (!next?.gapSeconds || next.gapSeconds < 4 || next.gapSeconds > 10)
    throw new Error('Grouped Page DM gap is missing');
  return next.gapSeconds;
}
