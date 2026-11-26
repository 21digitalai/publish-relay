import { randomUUID } from 'node:crypto';
import { and, desc, eq, lte, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { instagramUnifiedPendingIntents } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export type InstagramUnifiedPendingInput = {
  workspaceId: string; accountId: string; clientActionId: string; kind: 'comment_reply' | 'dm_reply';
  targetId: string; parentId: string; recipientId?: string; text: string; requestFingerprint: string;
  targetFingerprint: string; actor: { type: 'user' | 'api-key' | 'delegated'; id: string }; dueAt: Date;
};

const projection = {
  id: instagramUnifiedPendingIntents.id, workspaceId: instagramUnifiedPendingIntents.workspaceId,
  accountId: instagramUnifiedPendingIntents.accountId, clientActionId: instagramUnifiedPendingIntents.clientActionId,
  kind: instagramUnifiedPendingIntents.kind, targetId: instagramUnifiedPendingIntents.targetId,
  parentId: instagramUnifiedPendingIntents.parentId, recipientId: instagramUnifiedPendingIntents.recipientId,
  text: instagramUnifiedPendingIntents.textBody, requestFingerprint: instagramUnifiedPendingIntents.requestFingerprint,
  actorType: instagramUnifiedPendingIntents.actorType, actorId: instagramUnifiedPendingIntents.actorId,
  dueAt: instagramUnifiedPendingIntents.dueAt, status: instagramUnifiedPendingIntents.status,
  targetFingerprint: instagramUnifiedPendingIntents.targetFingerprint,
  leaseOwner: instagramUnifiedPendingIntents.leaseOwner,
};

export class InstagramUnifiedPendingConflictError extends Error {}

export async function scheduleInstagramUnifiedIntent(database: NodePgDatabase, input: InstagramUnifiedPendingInput) {
  return withTenantTransaction(database, input, async (tx) => {
    const actorType = input.actor.type === 'api-key' ? 'api_key' : input.actor.type;
    const [inserted] = await tx.insert(instagramUnifiedPendingIntents).values({
      workspaceId: input.workspaceId, accountId: input.accountId, clientActionId: input.clientActionId,
      kind: input.kind, targetId: input.targetId, parentId: input.parentId, recipientId: input.recipientId,
      textBody: input.text, requestFingerprint: input.requestFingerprint, targetFingerprint: input.targetFingerprint,
      actorType, actorId: input.actor.id, dueAt: input.dueAt,
    }).onConflictDoNothing().returning(projection);
    if (inserted) return inserted;
    const [existing] = await tx.select(projection).from(instagramUnifiedPendingIntents).where(and(
      eq(instagramUnifiedPendingIntents.workspaceId, input.workspaceId),
      eq(instagramUnifiedPendingIntents.clientActionId, input.clientActionId),
    )).limit(1);
    const immutablePayloadMatches = existing
      && existing.accountId === input.accountId
      && existing.kind === input.kind
      && existing.targetId === input.targetId
      && existing.parentId === input.parentId
      && existing.recipientId === (input.recipientId ?? null)
      && existing.text === input.text
      && existing.requestFingerprint === input.requestFingerprint
      && existing.targetFingerprint === input.targetFingerprint
      && existing.dueAt.getTime() === input.dueAt.getTime();
    if (!immutablePayloadMatches || existing.actorId !== input.actor.id || existing.actorType !== actorType)
      throw new InstagramUnifiedPendingConflictError('Scheduled Unified Instagram action conflicts with an existing action');
    return existing;
  });
}

export async function getInstagramUnifiedIntent(database: NodePgDatabase, input: { workspaceId: string; accountId: string; id: string }) {
  return withTenantTransaction(database, input, async (tx) => {
    const [row] = await tx.select(projection).from(instagramUnifiedPendingIntents).where(and(
      eq(instagramUnifiedPendingIntents.workspaceId, input.workspaceId), eq(instagramUnifiedPendingIntents.accountId, input.accountId), eq(instagramUnifiedPendingIntents.id, input.id),
    )).limit(1);
    return row ?? null;
  });
}

export async function listInstagramUnifiedIntents(database: NodePgDatabase, input: {
  workspaceId: string; accountId: string; limit?: number | undefined; status?: string | undefined;
}) {
  return withTenantTransaction(database, input, async (tx) => {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const rows = await tx.select(projection).from(instagramUnifiedPendingIntents).where(and(
      eq(instagramUnifiedPendingIntents.workspaceId, input.workspaceId),
      eq(instagramUnifiedPendingIntents.accountId, input.accountId),
      input.status ? eq(instagramUnifiedPendingIntents.status, input.status as typeof instagramUnifiedPendingIntents.status.enumValues[number]) : undefined,
    )).orderBy(desc(instagramUnifiedPendingIntents.dueAt), desc(instagramUnifiedPendingIntents.id)).limit(limit + 1);
    return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
  });
}

export async function cancelInstagramUnifiedIntent(database: NodePgDatabase, input: { workspaceId: string; accountId: string; id: string }) {
  return withTenantTransaction(database, input, async (tx) => {
    const [row] = await tx.update(instagramUnifiedPendingIntents).set({ status: 'cancelled', updatedAt: new Date() }).where(and(
      eq(instagramUnifiedPendingIntents.workspaceId, input.workspaceId), eq(instagramUnifiedPendingIntents.accountId, input.accountId), eq(instagramUnifiedPendingIntents.id, input.id), eq(instagramUnifiedPendingIntents.status, 'pending'),
    )).returning({ id: instagramUnifiedPendingIntents.id });
    return Boolean(row);
  });
}

export async function claimDueInstagramUnifiedIntent(database: NodePgDatabase, input: { workerId: string; now: Date; leaseMs: number }) {
  return database.transaction(async (tx) => {
    const eligible = or(eq(instagramUnifiedPendingIntents.status, 'pending'), and(eq(instagramUnifiedPendingIntents.status, 'claimed'), lte(instagramUnifiedPendingIntents.leaseUntil, input.now)));
    const [candidate] = await tx.select({ id: instagramUnifiedPendingIntents.id }).from(instagramUnifiedPendingIntents).where(and(lte(instagramUnifiedPendingIntents.dueAt, input.now), eligible)).orderBy(instagramUnifiedPendingIntents.dueAt, instagramUnifiedPendingIntents.id).limit(1);
    if (!candidate) return null;
    const [row] = await tx.update(instagramUnifiedPendingIntents).set({ status: 'claimed', leaseOwner: `${input.workerId}:${randomUUID()}`, leaseUntil: new Date(input.now.getTime() + input.leaseMs), updatedAt: input.now }).where(and(eq(instagramUnifiedPendingIntents.id, candidate.id), lte(instagramUnifiedPendingIntents.dueAt, input.now), eligible)).returning(projection);
    return row ?? null;
  });
}

export async function renewClaimedInstagramUnifiedIntent(database: NodePgDatabase, input: { workspaceId: string; id: string; leaseOwner: string; leaseMs: number }) {
  return withTenantTransaction(database, input, async (tx) => Boolean((await tx.update(instagramUnifiedPendingIntents).set({ leaseUntil: new Date(Date.now() + input.leaseMs), updatedAt: new Date() }).where(and(eq(instagramUnifiedPendingIntents.workspaceId, input.workspaceId), eq(instagramUnifiedPendingIntents.id, input.id), eq(instagramUnifiedPendingIntents.status, 'claimed'), eq(instagramUnifiedPendingIntents.leaseOwner, input.leaseOwner))).returning({ id: instagramUnifiedPendingIntents.id }))[0]));
}

export async function finishClaimedInstagramUnifiedIntent(database: NodePgDatabase, input: { workspaceId: string; id: string; leaseOwner: string; state: 'confirmed' | 'failed' | 'unknown' | 'expired' }) {
  return withTenantTransaction(database, input, async (tx) => Boolean((await tx.update(instagramUnifiedPendingIntents).set({ status: input.state, leaseOwner: null, leaseUntil: null, updatedAt: new Date() }).where(and(eq(instagramUnifiedPendingIntents.workspaceId, input.workspaceId), eq(instagramUnifiedPendingIntents.id, input.id), eq(instagramUnifiedPendingIntents.status, 'claimed'), eq(instagramUnifiedPendingIntents.leaseOwner, input.leaseOwner))).returning({ id: instagramUnifiedPendingIntents.id }))[0]));
}
