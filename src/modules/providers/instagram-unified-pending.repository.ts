import { and, eq } from 'drizzle-orm';
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
    if (!existing || existing.requestFingerprint !== input.requestFingerprint || existing.actorId !== input.actor.id || existing.actorType !== actorType)
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

export async function cancelInstagramUnifiedIntent(database: NodePgDatabase, input: { workspaceId: string; accountId: string; id: string }) {
  return withTenantTransaction(database, input, async (tx) => {
    const [row] = await tx.update(instagramUnifiedPendingIntents).set({ status: 'cancelled', updatedAt: new Date() }).where(and(
      eq(instagramUnifiedPendingIntents.workspaceId, input.workspaceId), eq(instagramUnifiedPendingIntents.accountId, input.accountId), eq(instagramUnifiedPendingIntents.id, input.id), eq(instagramUnifiedPendingIntents.status, 'pending'),
    )).returning({ id: instagramUnifiedPendingIntents.id });
    return Boolean(row);
  });
}
