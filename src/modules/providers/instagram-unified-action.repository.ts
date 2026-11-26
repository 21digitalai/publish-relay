import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { instagramUnifiedActions } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export type InstagramUnifiedActionInput = {
  workspaceId: string;
  accountId: string;
  clientActionId: string;
  kind: 'comment_reply' | 'dm_reply';
  targetId: string;
  parentId: string;
  recipientId?: string;
  text: string;
  requestFingerprint: string;
  actor: { type: 'user' | 'api-key' | 'delegated'; id: string };
};

export type InstagramUnifiedActionOutcome =
  | { state: 'confirmed'; receipt: string }
  | { state: 'failed'; failureStatus: number }
  | { state: 'unknown' };

export type InstagramUnifiedReservation = { kind: 'new'; id: string } | { kind: 'existing'; outcome: InstagramUnifiedActionOutcome } | { kind: 'conflict' };

function outcome(row: typeof instagramUnifiedActions.$inferSelect, input: InstagramUnifiedActionInput): InstagramUnifiedReservation {
  if (row.accountId !== input.accountId || row.kind !== input.kind || row.targetId !== input.targetId || row.parentId !== input.parentId || row.requestFingerprint !== input.requestFingerprint)
    return { kind: 'conflict' };
  if (row.state === 'confirmed' && row.providerReceipt) return { kind: 'existing', outcome: { state: 'confirmed', receipt: row.providerReceipt } };
  if (row.state === 'failed' && row.failureStatus) return { kind: 'existing', outcome: { state: 'failed', failureStatus: row.failureStatus } };
  return { kind: 'existing', outcome: { state: 'unknown' } };
}

export async function reserveInstagramUnifiedAction(database: NodePgDatabase, input: InstagramUnifiedActionInput): Promise<InstagramUnifiedReservation> {
  return withTenantTransaction(database, input, async (tx) => {
    const [inserted] = await tx.insert(instagramUnifiedActions).values({
      workspaceId: input.workspaceId, accountId: input.accountId, clientActionId: input.clientActionId,
      kind: input.kind, targetId: input.targetId, parentId: input.parentId, recipientId: input.recipientId ?? null,
      textBody: input.text, requestFingerprint: input.requestFingerprint,
      actorType: input.actor.type === 'api-key' ? 'api_key' : input.actor.type, actorId: input.actor.id,
    }).onConflictDoNothing().returning({ id: instagramUnifiedActions.id });
    if (inserted) return { kind: 'new', id: inserted.id };
    const [row] = await tx.select().from(instagramUnifiedActions).where(and(eq(instagramUnifiedActions.workspaceId, input.workspaceId), eq(instagramUnifiedActions.clientActionId, input.clientActionId))).limit(1);
    if (!row) throw new Error('Unified Instagram action reservation disappeared');
    return outcome(row, input);
  });
}

export async function settleInstagramUnifiedAction(database: NodePgDatabase, input: InstagramUnifiedActionInput & { reservationId: string; outcome: InstagramUnifiedActionOutcome }): Promise<void> {
  await withTenantTransaction(database, input, async (tx) => {
    const [updated] = await tx.update(instagramUnifiedActions).set({
      state: input.outcome.state,
      providerReceipt: input.outcome.state === 'confirmed' ? input.outcome.receipt : null,
      failureStatus: input.outcome.state === 'failed' ? input.outcome.failureStatus : null,
      updatedAt: new Date(),
    }).where(and(eq(instagramUnifiedActions.workspaceId, input.workspaceId), eq(instagramUnifiedActions.id, input.reservationId), eq(instagramUnifiedActions.state, 'reserved'))).returning({ id: instagramUnifiedActions.id });
    if (!updated) throw new Error('Unified Instagram action settlement lost reservation');
  });
}
