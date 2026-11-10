import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { auditEvents, facebookPageDmActions } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export interface FacebookDmActionKey {
  workspaceId: string;
  accountId: string;
  clientActionId: string;
  conversationId: string;
  text: string;
  receiverLabel?: string | null;
  requestFingerprint: string;
  actor: { type: 'user' | 'api-key' | 'delegated'; id: string };
}

export type FacebookDmOutcome =
  | { state: 'confirmed'; messageId: string }
  | { state: 'failed'; failureStatus: number }
  | { state: 'unknown' };

export type FacebookDmReservation =
  | { kind: 'new'; id: string }
  | { kind: 'conflict' }
  | { kind: 'existing'; outcome: FacebookDmOutcome };

function replay(
  row: {
    accountId: string;
    conversationId: string;
    requestFingerprint: string;
    state: string;
    providerMessageId: string | null;
    failureStatus: number | null;
  },
  input: FacebookDmActionKey,
): FacebookDmReservation {
  if (
    row.accountId !== input.accountId ||
    row.conversationId !== input.conversationId ||
    row.requestFingerprint !== input.requestFingerprint
  )
    return { kind: 'conflict' };
  if (row.state === 'confirmed' && row.providerMessageId)
    return { kind: 'existing', outcome: { state: 'confirmed', messageId: row.providerMessageId } };
  if (row.state === 'failed' && row.failureStatus)
    return { kind: 'existing', outcome: { state: 'failed', failureStatus: row.failureStatus } };
  return { kind: 'existing', outcome: { state: 'unknown' } };
}

async function readAction(transaction: NodePgDatabase, input: FacebookDmActionKey) {
  const [row] = await transaction
    .select({
      accountId: facebookPageDmActions.accountId,
      conversationId: facebookPageDmActions.conversationId,
      requestFingerprint: facebookPageDmActions.requestFingerprint,
      state: facebookPageDmActions.state,
      providerMessageId: facebookPageDmActions.providerMessageId,
      failureStatus: facebookPageDmActions.failureStatus,
    })
    .from(facebookPageDmActions)
    .where(
      and(
        eq(facebookPageDmActions.workspaceId, input.workspaceId),
        eq(facebookPageDmActions.clientActionId, input.clientActionId),
      ),
    )
    .limit(1);
  return row ? replay(row, input) : null;
}

export async function findFacebookDmAction(database: NodePgDatabase, input: FacebookDmActionKey) {
  return withTenantTransaction(database, input, (transaction) => readAction(transaction, input));
}

/** The reservation commits before the provider call; a crash leaves an unknown, never a retry. */
export async function reserveFacebookDmAction(
  database: NodePgDatabase,
  input: FacebookDmActionKey,
): Promise<FacebookDmReservation> {
  return withTenantTransaction(database, input, async (transaction) => {
    const [inserted] = await transaction
      .insert(facebookPageDmActions)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        clientActionId: input.clientActionId,
        conversationId: input.conversationId,
        textBody: input.text,
        receiverLabel: input.receiverLabel?.trim().slice(0, 200) ?? null,
        requestFingerprint: input.requestFingerprint,
        actorType: input.actor.type === 'api-key' ? 'api_key' : input.actor.type,
        actorId: input.actor.id,
      })
      .onConflictDoNothing()
      .returning({ id: facebookPageDmActions.id });
    if (inserted) return { kind: 'new', id: inserted.id };
    const existing = await readAction(transaction, input);
    if (!existing) throw new Error('Facebook DM reservation disappeared');
    return existing;
  });
}

export async function settleFacebookDmAction(
  database: NodePgDatabase,
  input: FacebookDmActionKey & { reservationId: string; outcome: FacebookDmOutcome },
): Promise<void> {
  await withTenantTransaction(database, input, async (transaction) => {
    const [updated] = await transaction
      .update(facebookPageDmActions)
      .set({
        state: input.outcome.state,
        providerMessageId: input.outcome.state === 'confirmed' ? input.outcome.messageId : null,
        failureStatus: input.outcome.state === 'failed' ? input.outcome.failureStatus : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(facebookPageDmActions.workspaceId, input.workspaceId),
          eq(facebookPageDmActions.id, input.reservationId),
          eq(facebookPageDmActions.state, 'reserved'),
        ),
      )
      .returning({ id: facebookPageDmActions.id });
    if (!updated) throw new Error('Facebook DM settlement lost reservation');
    await transaction.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorType: input.actor.type === 'api-key' ? 'api_key' : input.actor.type,
      actorId: input.actor.id,
      action: 'facebook_page.dm_send',
      targetType: 'provider_account',
      targetId: input.accountId,
      requestId: input.clientActionId,
      metadata: { outcome: input.outcome.state, conversationId: input.conversationId },
    });
  });
}
