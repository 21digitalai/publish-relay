import { createHash, randomInt, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { and, eq, isNull, lte, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import {
  engagementProposals,
  fanvueActionIntents,
  fanvueCommentPendingIntents as intents,
  fanvueDmDispatchPacing,
  fanvueDmPendingIntents,
  providerAccounts,
  providerConnections,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { lockFanvueActionNamespace } from './fanvue-action-namespace.js';

export const commentScheduleInput = z.strictObject({
  workspaceId: z.uuid(),
  accountId: z.uuid(),
  postUuid: z.uuid(),
  clientActionId: z.uuid(),
  actor: z.strictObject({ type: z.enum(['user', 'api-key', 'delegated']), id: z.uuid() }),
  text: z.string().min(1).max(600),
  targetLabel: z.string().min(1).max(160).nullable().optional(),
  dueAt: z.date(),
});

export class FanvueCommentScheduleConflictError extends Error {
  constructor() {
    super('Scheduled Fanvue comment action ID conflicts with prior input');
  }
}

const projection = {
  id: intents.id,
  workspaceId: intents.workspaceId,
  accountId: intents.accountId,
  postUuid: intents.postUuid,
  clientActionId: intents.clientActionId,
  actorType: intents.actorType,
  actorId: intents.actorId,
  text: intents.textBody,
  targetLabel: intents.targetLabel,
  dueAt: intents.dueAt,
  status: intents.status,
  leaseOwner: intents.leaseOwner,
};

type Input = z.output<typeof commentScheduleInput>;

function fingerprint(value: {
  accountId: string;
  postUuid: string;
  actorType: string;
  actorId: string;
  text: string;
  dueAt: Date;
}) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        accountId: value.accountId,
        postUuid: value.postUuid,
        actorType: value.actorType,
        actorId: value.actorId,
        text: value.text,
        dueAt: value.dueAt.toISOString(),
      }),
    )
    .digest('hex');
}

function expected(input: Input) {
  return fingerprint({
    accountId: input.accountId,
    postUuid: input.postUuid,
    actorType: input.actor.type === 'api-key' ? 'api_key' : input.actor.type,
    actorId: input.actor.id,
    text: input.text,
    dueAt: input.dueAt,
  });
}

export async function findScheduledFanvueComment(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; postUuid: string; clientActionId: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [row] = await tx
      .select(projection)
      .from(intents)
      .where(
        and(
          eq(intents.workspaceId, input.workspaceId),
          eq(intents.accountId, input.accountId),
          eq(intents.postUuid, input.postUuid),
          eq(intents.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function replayScheduledFanvueComment(
  database: NodePgDatabase,
  raw: z.input<typeof commentScheduleInput>,
) {
  const input = commentScheduleInput.parse(raw);
  const prior = await findScheduledFanvueComment(database, input);
  if (prior && fingerprint(prior) !== expected(input))
    throw new FanvueCommentScheduleConflictError();
  return prior;
}

async function insertComment(tx: NodePgDatabase, input: Input) {
  await lockFanvueActionNamespace(tx, input.workspaceId, input.clientActionId);
  const [otherKind] = await tx
    .select({ id: fanvueDmPendingIntents.id })
    .from(fanvueDmPendingIntents)
    .where(
      and(
        eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
        eq(fanvueDmPendingIntents.clientActionId, input.clientActionId),
      ),
    )
    .limit(1);
  if (otherKind) throw new FanvueCommentScheduleConflictError();
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
  if (account?.provider !== 'fanvue') throw new FanvueCommentScheduleConflictError();
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
  if (action) throw new FanvueCommentScheduleConflictError();
  const [inserted] = await tx
    .insert(intents)
    .values({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      postUuid: input.postUuid,
      clientActionId: input.clientActionId,
      actorType: input.actor.type === 'api-key' ? 'api_key' : input.actor.type,
      actorId: input.actor.id,
      textBody: input.text,
      targetLabel: input.targetLabel ?? null,
      dueAt: input.dueAt,
    })
    .onConflictDoNothing()
    .returning(projection);
  if (inserted) return inserted;
  const [prior] = await tx
    .select(projection)
    .from(intents)
    .where(
      and(
        eq(intents.workspaceId, input.workspaceId),
        eq(intents.clientActionId, input.clientActionId),
      ),
    )
    .limit(1);
  if (!prior || fingerprint(prior) !== expected(input))
    throw new FanvueCommentScheduleConflictError();
  return prior;
}

export async function scheduleFanvueComment(
  database: NodePgDatabase,
  raw: z.input<typeof commentScheduleInput>,
) {
  const input = commentScheduleInput.parse(raw);
  return withTenantTransaction(database, input, (tx) => insertComment(tx, input));
}

export async function scheduleApprovedFanvueComment(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    proposalId: string;
    expectedRevision: number;
    userId: string;
    accountId: string;
    postUuid: string;
    clientActionId: string;
    content: unknown;
    text: string;
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
    const proposal = selected?.proposal;
    if (
      proposal?.status !== 'pending' ||
      proposal.revision !== input.expectedRevision ||
      proposal.provider !== 'fanvue' ||
      proposal.kind !== 'comment' ||
      proposal.accountId !== input.accountId ||
      proposal.targetId !== input.postUuid ||
      proposal.clientActionId !== input.clientActionId ||
      !isDeepStrictEqual(proposal.content, input.content) ||
      selected?.availability !== 'active' ||
      selected.disconnectedAt ||
      selected.connectionStatus !== 'active' ||
      selected.revokedAt
    )
      throw new FanvueCommentScheduleConflictError();
    const now = new Date();
    const dueAt =
      proposal.plannedDueAt && proposal.plannedDueAt > now ? proposal.plannedDueAt : now;
    const intent = await insertComment(
      tx,
      commentScheduleInput.parse({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        postUuid: input.postUuid,
        clientActionId: input.clientActionId,
        actor: { type: 'user', id: input.userId },
        text: input.text,
        targetLabel: input.targetLabel,
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

export async function cancelPendingFanvueComment(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    accountId: string;
    postUuid: string;
    clientActionId: string;
  },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [cancelled] = await tx
      .update(intents)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(intents.workspaceId, input.workspaceId),
          eq(intents.accountId, input.accountId),
          eq(intents.postUuid, input.postUuid),
          eq(intents.clientActionId, input.clientActionId),
          eq(intents.status, 'pending'),
        ),
      )
      .returning({ id: intents.id });
    if (cancelled)
      await tx
        .update(engagementProposals)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(
          and(
            eq(engagementProposals.workspaceId, input.workspaceId),
            eq(engagementProposals.clientActionId, input.clientActionId),
            eq(engagementProposals.provider, 'fanvue'),
            eq(engagementProposals.kind, 'comment'),
            eq(engagementProposals.status, 'scheduled'),
          ),
        );
    return Boolean(cancelled);
  });
}

export async function cancelScheduledProposalFanvueComment(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    proposalId: string;
  },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [proposal] = await tx
      .select({ clientActionId: engagementProposals.clientActionId })
      .from(engagementProposals)
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.proposalId),
          eq(engagementProposals.provider, 'fanvue'),
          eq(engagementProposals.kind, 'comment'),
          eq(engagementProposals.status, 'scheduled'),
        ),
      )
      .limit(1);
    if (!proposal) return false;
    const [cancelled] = await tx
      .update(intents)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(intents.workspaceId, input.workspaceId),
          eq(intents.clientActionId, proposal.clientActionId),
          eq(intents.status, 'pending'),
        ),
      )
      .returning({ id: intents.id });
    if (!cancelled) return false;
    await tx
      .update(engagementProposals)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.proposalId),
        ),
      );
    return true;
  });
}

/** The shared Fanvue account pacing cursor serializes comment and DM dispatch. */
export async function claimDueFanvueComment(
  database: NodePgDatabase,
  input: {
    workerId: string;
    now: Date;
    leaseMs: number;
  },
) {
  return database.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: intents.id, workspaceId: intents.workspaceId, accountId: intents.accountId })
      .from(intents)
      .leftJoin(
        fanvueDmDispatchPacing,
        and(
          eq(fanvueDmDispatchPacing.workspaceId, intents.workspaceId),
          eq(fanvueDmDispatchPacing.accountId, intents.accountId),
        ),
      )
      .where(
        and(
          lte(intents.dueAt, input.now),
          or(
            isNull(fanvueDmDispatchPacing.accountId),
            lte(fanvueDmDispatchPacing.nextAt, input.now),
          ),
          or(
            eq(intents.status, 'pending'),
            and(eq(intents.status, 'claimed'), lte(intents.leaseUntil, input.now)),
          ),
        ),
      )
      .orderBy(intents.dueAt, intents.id)
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
    const [pace] = await tx
      .select({ nextAt: fanvueDmDispatchPacing.nextAt })
      .from(fanvueDmDispatchPacing)
      .where(
        and(
          eq(fanvueDmDispatchPacing.workspaceId, candidate.workspaceId),
          eq(fanvueDmDispatchPacing.accountId, candidate.accountId),
        ),
      )
      .limit(1);
    if (pace && pace.nextAt > input.now) return null;
    const [claimed] = await tx
      .update(intents)
      .set({
        status: 'claimed',
        leaseOwner: `${input.workerId}:${randomUUID()}`,
        leaseUntil: new Date(input.now.getTime() + input.leaseMs),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(intents.id, candidate.id),
          lte(intents.dueAt, input.now),
          or(
            eq(intents.status, 'pending'),
            and(eq(intents.status, 'claimed'), lte(intents.leaseUntil, input.now)),
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
          eq(engagementProposals.kind, 'comment'),
          eq(engagementProposals.status, 'scheduled'),
        ),
      );
    const nextAt = new Date(input.now.getTime() + randomInt(60, 121) * 1000);
    await tx
      .insert(fanvueDmDispatchPacing)
      .values({ workspaceId: candidate.workspaceId, accountId: candidate.accountId, nextAt })
      .onConflictDoUpdate({
        target: [fanvueDmDispatchPacing.workspaceId, fanvueDmDispatchPacing.accountId],
        set: { nextAt },
      });
    return claimed;
  });
}

export async function renewClaimedFanvueComment(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    id: string;
    leaseOwner: string;
    leaseMs: number;
  },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [row] = await tx
      .update(intents)
      .set({ leaseUntil: new Date(Date.now() + input.leaseMs), updatedAt: new Date() })
      .where(
        and(
          eq(intents.workspaceId, input.workspaceId),
          eq(intents.id, input.id),
          eq(intents.status, 'claimed'),
          eq(intents.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({ id: intents.id });
    return Boolean(row);
  });
}

export async function finishClaimedFanvueComment(
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
      .select({ clientActionId: intents.clientActionId })
      .from(intents)
      .where(
        and(
          eq(intents.workspaceId, input.workspaceId),
          eq(intents.id, input.id),
          eq(intents.status, 'claimed'),
          eq(intents.leaseOwner, input.leaseOwner),
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
      if (action) throw new Error('Cannot retry Fanvue comment after action reservation');
    }
    const [settled] = await tx
      .update(intents)
      .set({
        status: input.state,
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(intents.workspaceId, input.workspaceId),
          eq(intents.id, input.id),
          eq(intents.status, 'claimed'),
          eq(intents.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({ id: intents.id });
    if (settled)
      await tx
        .update(engagementProposals)
        .set({
          status:
            input.state === 'confirmed'
              ? 'sent'
              : input.state === 'pending'
                ? 'scheduled'
                : input.state,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(engagementProposals.workspaceId, input.workspaceId),
            eq(engagementProposals.clientActionId, intent.clientActionId),
            eq(engagementProposals.provider, 'fanvue'),
            eq(engagementProposals.kind, 'comment'),
            eq(engagementProposals.status, 'sending'),
          ),
        );
    return Boolean(settled);
  });
}
