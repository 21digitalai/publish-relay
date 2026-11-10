import { randomInt, randomUUID } from 'node:crypto';

import { and, eq, isNull, lte, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  facebookPageCommentActions,
  facebookPageCommentDispatchPacing,
  facebookPageCommentPendingIntents,
  providerAccounts,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export interface PendingCommentInput {
  workspaceId: string;
  accountId: string;
  postId: string;
  commentId: string;
  clientActionId: string;
  requestFingerprint: string;
  actor: { type: 'user' | 'api-key' | 'delegated'; id: string };
  text: string;
  targetText: string;
  targetCreatedAt: string;
  threadFingerprint: string;
  dueAt: Date;
}

export class PendingCommentConflictError extends Error {
  constructor(message = 'Scheduled comment conflicts with an existing action') {
    super(message);
  }
}

const projection = {
  id: facebookPageCommentPendingIntents.id,
  workspaceId: facebookPageCommentPendingIntents.workspaceId,
  accountId: facebookPageCommentPendingIntents.accountId,
  postId: facebookPageCommentPendingIntents.postId,
  commentId: facebookPageCommentPendingIntents.commentId,
  clientActionId: facebookPageCommentPendingIntents.clientActionId,
  requestFingerprint: facebookPageCommentPendingIntents.requestFingerprint,
  actorType: facebookPageCommentPendingIntents.actorType,
  actorId: facebookPageCommentPendingIntents.actorId,
  text: facebookPageCommentPendingIntents.textBody,
  targetText: facebookPageCommentPendingIntents.targetText,
  targetCreatedAt: facebookPageCommentPendingIntents.targetCreatedAt,
  threadFingerprint: facebookPageCommentPendingIntents.threadFingerprint,
  dueAt: facebookPageCommentPendingIntents.dueAt,
  status: facebookPageCommentPendingIntents.status,
  preSendAttempts: facebookPageCommentPendingIntents.preSendAttempts,
  leaseOwner: facebookPageCommentPendingIntents.leaseOwner,
};

export async function schedulePageComment(database: NodePgDatabase, input: PendingCommentInput) {
  return withTenantTransaction(database, input, async (tx) => {
    const actorType = input.actor.type === 'api-key' ? 'api_key' : input.actor.type;
    const [action] = await tx
      .select({ id: facebookPageCommentActions.id })
      .from(facebookPageCommentActions)
      .where(
        and(
          eq(facebookPageCommentActions.workspaceId, input.workspaceId),
          eq(facebookPageCommentActions.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    if (action) throw new PendingCommentConflictError();
    const [inserted] = await tx
      .insert(facebookPageCommentPendingIntents)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        postId: input.postId,
        commentId: input.commentId,
        clientActionId: input.clientActionId,
        requestFingerprint: input.requestFingerprint,
        actorType,
        actorId: input.actor.id,
        textBody: input.text,
        targetText: input.targetText,
        targetCreatedAt: input.targetCreatedAt,
        threadFingerprint: input.threadFingerprint,
        dueAt: input.dueAt,
      })
      .onConflictDoNothing()
      .returning(projection);
    if (inserted) return inserted;
    const [existing] = await tx
      .select(projection)
      .from(facebookPageCommentPendingIntents)
      .where(
        and(
          eq(facebookPageCommentPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageCommentPendingIntents.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    if (
      existing?.accountId !== input.accountId ||
      existing.postId !== input.postId ||
      existing.commentId !== input.commentId ||
      existing.requestFingerprint !== input.requestFingerprint ||
      existing.actorType !== actorType ||
      existing.actorId !== input.actor.id
    )
      throw new PendingCommentConflictError();
    return existing;
  });
}

export async function getPageCommentIntent(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; id: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [row] = await tx
      .select(projection)
      .from(facebookPageCommentPendingIntents)
      .where(
        and(
          eq(facebookPageCommentPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageCommentPendingIntents.accountId, input.accountId),
          eq(facebookPageCommentPendingIntents.id, input.id),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function getPageCommentIntentByAction(
  database: NodePgDatabase,
  input: { workspaceId: string; clientActionId: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [row] = await tx
      .select(projection)
      .from(facebookPageCommentPendingIntents)
      .where(
        and(
          eq(facebookPageCommentPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageCommentPendingIntents.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function cancelPageCommentIntent(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; id: string },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [row] = await tx
      .update(facebookPageCommentPendingIntents)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(facebookPageCommentPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageCommentPendingIntents.accountId, input.accountId),
          eq(facebookPageCommentPendingIntents.id, input.id),
          eq(facebookPageCommentPendingIntents.status, 'pending'),
        ),
      )
      .returning({ id: facebookPageCommentPendingIntents.id });
    return Boolean(row);
  });
}

/** Worker role has BYPASSRLS; lock the Page before the intent to serialize pacing. */
export async function claimDuePageComment(
  database: NodePgDatabase,
  input: { workerId: string; now: Date; leaseMs: number },
) {
  return database.transaction(async (tx) => {
    const [candidate] = await tx
      .select({
        id: facebookPageCommentPendingIntents.id,
        workspaceId: facebookPageCommentPendingIntents.workspaceId,
        accountId: facebookPageCommentPendingIntents.accountId,
      })
      .from(facebookPageCommentPendingIntents)
      .leftJoin(
        facebookPageCommentDispatchPacing,
        and(
          eq(
            facebookPageCommentDispatchPacing.workspaceId,
            facebookPageCommentPendingIntents.workspaceId,
          ),
          eq(
            facebookPageCommentDispatchPacing.accountId,
            facebookPageCommentPendingIntents.accountId,
          ),
        ),
      )
      .where(
        and(
          lte(facebookPageCommentPendingIntents.dueAt, input.now),
          or(
            isNull(facebookPageCommentDispatchPacing.accountId),
            lte(facebookPageCommentDispatchPacing.nextAt, input.now),
            eq(
              facebookPageCommentDispatchPacing.lastIntentId,
              facebookPageCommentPendingIntents.id,
            ),
          ),
          or(
            eq(facebookPageCommentPendingIntents.status, 'pending'),
            and(
              eq(facebookPageCommentPendingIntents.status, 'claimed'),
              lte(facebookPageCommentPendingIntents.leaseUntil, input.now),
            ),
          ),
        ),
      )
      .orderBy(facebookPageCommentPendingIntents.dueAt, facebookPageCommentPendingIntents.id)
      .limit(1);
    if (!candidate) return null;
    await tx
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.workspaceId, candidate.workspaceId),
          eq(providerAccounts.id, candidate.accountId),
        ),
      )
      .limit(1)
      .for('update');
    const [locked] = await tx
      .select({ id: facebookPageCommentPendingIntents.id })
      .from(facebookPageCommentPendingIntents)
      .where(
        and(
          eq(facebookPageCommentPendingIntents.id, candidate.id),
          lte(facebookPageCommentPendingIntents.dueAt, input.now),
          or(
            eq(facebookPageCommentPendingIntents.status, 'pending'),
            and(
              eq(facebookPageCommentPendingIntents.status, 'claimed'),
              lte(facebookPageCommentPendingIntents.leaseUntil, input.now),
            ),
          ),
        ),
      )
      .limit(1)
      .for('update', { skipLocked: true });
    if (!locked) return null;
    const [pacing] = await tx
      .select({
        nextAt: facebookPageCommentDispatchPacing.nextAt,
        lastIntentId: facebookPageCommentDispatchPacing.lastIntentId,
      })
      .from(facebookPageCommentDispatchPacing)
      .where(
        and(
          eq(facebookPageCommentDispatchPacing.workspaceId, candidate.workspaceId),
          eq(facebookPageCommentDispatchPacing.accountId, candidate.accountId),
        ),
      )
      .limit(1);
    if (pacing?.lastIntentId !== candidate.id) {
      if (pacing && pacing.nextAt > input.now) return null;
      const nextAt = new Date(input.now.getTime() + randomInt(60, 121) * 1000);
      await tx
        .insert(facebookPageCommentDispatchPacing)
        .values({
          workspaceId: candidate.workspaceId,
          accountId: candidate.accountId,
          nextAt,
          lastIntentId: candidate.id,
        })
        .onConflictDoUpdate({
          target: [
            facebookPageCommentDispatchPacing.workspaceId,
            facebookPageCommentDispatchPacing.accountId,
          ],
          set: { nextAt, lastIntentId: candidate.id },
        });
    }
    const [row] = await tx
      .update(facebookPageCommentPendingIntents)
      .set({
        status: 'claimed',
        leaseOwner: `${input.workerId}:${randomUUID()}`,
        leaseUntil: new Date(input.now.getTime() + input.leaseMs),
        updatedAt: input.now,
      })
      .where(eq(facebookPageCommentPendingIntents.id, candidate.id))
      .returning(projection);
    return row ?? null;
  });
}

export async function renewClaimedPageComment(
  database: NodePgDatabase,
  input: { workspaceId: string; id: string; leaseOwner: string; leaseMs: number },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [row] = await tx
      .update(facebookPageCommentPendingIntents)
      .set({ leaseUntil: new Date(Date.now() + input.leaseMs), updatedAt: new Date() })
      .where(
        and(
          eq(facebookPageCommentPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageCommentPendingIntents.id, input.id),
          eq(facebookPageCommentPendingIntents.status, 'claimed'),
          eq(facebookPageCommentPendingIntents.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({ id: facebookPageCommentPendingIntents.id });
    return Boolean(row);
  });
}

export async function finishClaimedPageComment(
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
        clientActionId: facebookPageCommentPendingIntents.clientActionId,
        attempts: facebookPageCommentPendingIntents.preSendAttempts,
      })
      .from(facebookPageCommentPendingIntents)
      .where(
        and(
          eq(facebookPageCommentPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageCommentPendingIntents.id, input.id),
          eq(facebookPageCommentPendingIntents.status, 'claimed'),
          eq(facebookPageCommentPendingIntents.leaseOwner, input.leaseOwner),
        ),
      )
      .for('update');
    if (!intent) return false;
    if (input.state === 'pending') {
      const [action] = await tx
        .select({ id: facebookPageCommentActions.id })
        .from(facebookPageCommentActions)
        .where(
          and(
            eq(facebookPageCommentActions.workspaceId, input.workspaceId),
            eq(facebookPageCommentActions.clientActionId, intent.clientActionId),
          ),
        )
        .limit(1);
      if (action) throw new Error('Cannot retry a reserved Page comment action');
    }
    const attempts = intent.attempts + (input.state === 'pending' ? 1 : 0);
    const state = input.state === 'pending' && attempts >= 3 ? 'failed' : input.state;
    const [updated] = await tx
      .update(facebookPageCommentPendingIntents)
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
      .where(eq(facebookPageCommentPendingIntents.id, input.id))
      .returning({ id: facebookPageCommentPendingIntents.id });
    return Boolean(updated);
  });
}
