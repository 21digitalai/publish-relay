import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { instagramUnifiedActions, providerAccounts } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export interface InstagramUnifiedActionInput {
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
}

export type InstagramUnifiedActionOutcome =
  | { state: 'confirmed'; receipt: string }
  | { state: 'failed'; failureStatus: number }
  | { state: 'unknown' };

export type InstagramUnifiedReservation = { kind: 'new'; id: string } | { kind: 'existing'; outcome: InstagramUnifiedActionOutcome } | { kind: 'conflict' };

async function reserveInTransaction(database: NodePgDatabase, input: InstagramUnifiedActionInput): Promise<InstagramUnifiedReservation> {
  const [inserted] = await database.insert(instagramUnifiedActions).values({
    workspaceId: input.workspaceId, accountId: input.accountId, clientActionId: input.clientActionId,
    kind: input.kind, targetId: input.targetId, parentId: input.parentId, recipientId: input.recipientId ?? null,
    textBody: input.text, requestFingerprint: input.requestFingerprint,
    actorType: input.actor.type === 'api-key' ? 'api_key' : input.actor.type, actorId: input.actor.id,
  }).onConflictDoNothing().returning({ id: instagramUnifiedActions.id });
  if (inserted) return { kind: 'new', id: inserted.id };
  const [row] = await database.select().from(instagramUnifiedActions).where(and(eq(instagramUnifiedActions.workspaceId, input.workspaceId), eq(instagramUnifiedActions.clientActionId, input.clientActionId))).limit(1);
  if (!row) throw new Error('Unified Instagram action reservation disappeared');
  return outcome(row, input);
}

async function settleInTransaction(database: NodePgDatabase, input: InstagramUnifiedActionInput & { reservationId: string; outcome: InstagramUnifiedActionOutcome }): Promise<void> {
  const [updated] = await database.update(instagramUnifiedActions).set({
    state: input.outcome.state,
    providerReceipt: input.outcome.state === 'confirmed' ? input.outcome.receipt : null,
    failureStatus: input.outcome.state === 'failed' ? input.outcome.failureStatus : null,
    updatedAt: new Date(),
  }).where(and(eq(instagramUnifiedActions.workspaceId, input.workspaceId), eq(instagramUnifiedActions.id, input.reservationId), eq(instagramUnifiedActions.state, 'reserved'))).returning({ id: instagramUnifiedActions.id });
  if (!updated) throw new Error('Unified Instagram action settlement lost reservation');
}

function outcome(row: typeof instagramUnifiedActions.$inferSelect, input: InstagramUnifiedActionInput): InstagramUnifiedReservation {
  if (row.accountId !== input.accountId || row.kind !== input.kind || row.targetId !== input.targetId || row.parentId !== input.parentId || row.requestFingerprint !== input.requestFingerprint)
    return { kind: 'conflict' };
  if (row.state === 'confirmed' && row.providerReceipt) return { kind: 'existing', outcome: { state: 'confirmed', receipt: row.providerReceipt } };
  if (row.state === 'failed' && row.failureStatus) return { kind: 'existing', outcome: { state: 'failed', failureStatus: row.failureStatus } };
  return { kind: 'existing', outcome: { state: 'unknown' } };
}

export async function reserveInstagramUnifiedAction(database: NodePgDatabase, input: InstagramUnifiedActionInput): Promise<InstagramUnifiedReservation> {
  return withTenantTransaction(database, input, (tx) => reserveInTransaction(tx, input));
}

export async function settleInstagramUnifiedAction(database: NodePgDatabase, input: InstagramUnifiedActionInput & { reservationId: string; outcome: InstagramUnifiedActionOutcome }): Promise<void> {
  await withTenantTransaction(database, input, (tx) => settleInTransaction(tx, input));
}

export async function withInstagramUnifiedActionDispatch(
  database: NodePgDatabase,
  input: InstagramUnifiedActionInput,
  dispatch: (transaction: NodePgDatabase, reservationId: string) => Promise<InstagramUnifiedActionOutcome>,
): Promise<InstagramUnifiedReservation | InstagramUnifiedActionOutcome | { kind: 'settlement-error'; error: unknown }> {
  // Commit the no-replay receipt before any provider effect. The dispatch transaction
  // can then roll back (or its connection can die) without erasing that receipt.
  const reservation = await reserveInstagramUnifiedAction(database, input);
  if (reservation.kind !== 'new') return reservation;
  return withTenantTransaction(database, input, async (tx) => {
    const [account] = await tx.select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(and(eq(providerAccounts.workspaceId, input.workspaceId), eq(providerAccounts.id, input.accountId)))
      .for('update')
      .limit(1);
    if (!account) throw new Error('Unified Instagram account unavailable');
    const result = await dispatch(tx, reservation.id);
    try {
      await tx.transaction((settlementTransaction) =>
        settleInTransaction(settlementTransaction, {
          ...input,
          reservationId: reservation.id,
          outcome: result,
        }),
      );
    } catch (error) {
      return { kind: 'settlement-error', error };
    }
    return result;
  });
}
