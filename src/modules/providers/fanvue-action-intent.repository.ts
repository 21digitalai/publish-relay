import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { fanvueActionIntents } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export type FanvueActionKind = 'message' | 'comment';
export type FanvueActionState = 'reserved' | 'confirmed' | 'failed' | 'unknown';

export interface FanvueActionInput {
  workspaceId: string;
  accountId: string;
  clientActionId: string;
  actionKind: FanvueActionKind;
  targetUuid: string;
  requestFingerprint: string;
}

export type FanvueActionReservation =
  | { kind: 'new'; id: string }
  | { kind: 'conflict' }
  | {
      kind: 'existing';
      state: FanvueActionState;
      providerObjectUuid: string | null;
      failureStatus: number | null;
    };

/** Commit this reservation before the provider POST. An existing reserved row is ambiguous. */
export async function reserveFanvueAction(
  database: NodePgDatabase,
  input: FanvueActionInput,
): Promise<FanvueActionReservation> {
  z.uuid().parse(input.clientActionId);
  z.uuid().parse(input.targetUuid);
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.requestFingerprint);
  return withTenantTransaction(database, input, async (transaction) => {
    const inserted = await transaction
      .insert(fanvueActionIntents)
      .values(input)
      .onConflictDoNothing()
      .returning({ id: fanvueActionIntents.id });
    if (inserted[0]) return { kind: 'new', id: inserted[0].id };
    const rows = await transaction
      .select({
        actionKind: fanvueActionIntents.actionKind,
        targetUuid: fanvueActionIntents.targetUuid,
        requestFingerprint: fanvueActionIntents.requestFingerprint,
        state: fanvueActionIntents.state,
        providerObjectUuid: fanvueActionIntents.providerObjectUuid,
        failureStatus: fanvueActionIntents.failureStatus,
      })
      .from(fanvueActionIntents)
      .where(
        and(
          eq(fanvueActionIntents.workspaceId, input.workspaceId),
          eq(fanvueActionIntents.accountId, input.accountId),
          eq(fanvueActionIntents.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    const stored = rows[0];
    if (!stored) throw new Error('Fanvue action reservation disappeared');
    if (
      stored.actionKind !== input.actionKind ||
      stored.targetUuid !== input.targetUuid ||
      stored.requestFingerprint !== input.requestFingerprint
    )
      return { kind: 'conflict' };
    return {
      kind: 'existing',
      state: stored.state as FanvueActionState,
      providerObjectUuid: stored.providerObjectUuid,
      failureStatus: stored.failureStatus,
    };
  });
}

/** Only the original sender may settle a reservation; replays never call this. */
export async function settleFanvueAction(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    accountId: string;
    clientActionId: string;
    reservationId: string;
    result:
      | { state: 'confirmed'; providerObjectUuid: string }
      | { state: 'failed'; failureStatus: number }
      | { state: 'unknown' };
  },
): Promise<void> {
  z.uuid().parse(input.reservationId);
  if (input.result.state === 'confirmed') z.uuid().parse(input.result.providerObjectUuid);
  if (input.result.state === 'failed')
    z.number().int().min(400).max(499).parse(input.result.failureStatus);
  await withTenantTransaction(database, input, async (transaction) => {
    const rows = await transaction
      .update(fanvueActionIntents)
      .set({ ...input.result, updatedAt: new Date() })
      .where(
        and(
          eq(fanvueActionIntents.workspaceId, input.workspaceId),
          eq(fanvueActionIntents.accountId, input.accountId),
          eq(fanvueActionIntents.clientActionId, input.clientActionId),
          eq(fanvueActionIntents.id, input.reservationId),
          eq(fanvueActionIntents.state, 'reserved'),
        ),
      )
      .returning({ id: fanvueActionIntents.id });
    if (rows.length !== 1) throw new Error('Fanvue action intent was not reserved');
  });
}
