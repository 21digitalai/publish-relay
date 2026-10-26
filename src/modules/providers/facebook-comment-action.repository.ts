import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { auditEvents, facebookPageCommentActions } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export interface FacebookCommentActionKey {
  workspaceId: string;
  accountId: string;
  clientActionId: string;
  commentId: string;
  requestFingerprint: string;
  actor: { type: 'user' | 'api-key' | 'delegated'; id: string };
}

export type FacebookCommentOutcome =
  | { state: 'confirmed'; commentId: string }
  | { state: 'failed'; failureStatus: number }
  | { state: 'unknown' };

export type FacebookCommentReservation =
  | { kind: 'new'; id: string }
  | { kind: 'conflict' }
  | { kind: 'existing'; outcome: FacebookCommentOutcome };

function replay(
  row: {
    accountId: string;
    commentId: string;
    requestFingerprint: string;
    state: string;
    providerCommentId: string | null;
    failureStatus: number | null;
  },
  input: FacebookCommentActionKey,
): FacebookCommentReservation {
  if (
    row.accountId !== input.accountId ||
    row.commentId !== input.commentId ||
    row.requestFingerprint !== input.requestFingerprint
  )
    return { kind: 'conflict' };
  if (row.state === 'confirmed' && row.providerCommentId)
    return { kind: 'existing', outcome: { state: 'confirmed', commentId: row.providerCommentId } };
  if (row.state === 'failed' && row.failureStatus)
    return { kind: 'existing', outcome: { state: 'failed', failureStatus: row.failureStatus } };
  return { kind: 'existing', outcome: { state: 'unknown' } };
}

async function readAction(transaction: NodePgDatabase, input: FacebookCommentActionKey) {
  const [row] = await transaction
    .select({
      accountId: facebookPageCommentActions.accountId,
      commentId: facebookPageCommentActions.commentId,
      requestFingerprint: facebookPageCommentActions.requestFingerprint,
      state: facebookPageCommentActions.state,
      providerCommentId: facebookPageCommentActions.providerCommentId,
      failureStatus: facebookPageCommentActions.failureStatus,
    })
    .from(facebookPageCommentActions)
    .where(
      and(
        eq(facebookPageCommentActions.workspaceId, input.workspaceId),
        eq(facebookPageCommentActions.clientActionId, input.clientActionId),
      ),
    )
    .limit(1);
  return row ? replay(row, input) : null;
}

export async function findFacebookCommentAction(
  database: NodePgDatabase,
  input: FacebookCommentActionKey,
) {
  return withTenantTransaction(database, input, (transaction) => readAction(transaction, input));
}

/** The reservation commits before the provider call; a crash leaves an unknown, never a retry. */
export async function reserveFacebookCommentAction(
  database: NodePgDatabase,
  input: FacebookCommentActionKey,
): Promise<FacebookCommentReservation> {
  return withTenantTransaction(database, input, async (transaction) => {
    const [inserted] = await transaction
      .insert(facebookPageCommentActions)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        clientActionId: input.clientActionId,
        commentId: input.commentId,
        requestFingerprint: input.requestFingerprint,
        actorType: input.actor.type === 'api-key' ? 'api_key' : input.actor.type,
        actorId: input.actor.id,
      })
      .onConflictDoNothing()
      .returning({ id: facebookPageCommentActions.id });
    if (inserted) return { kind: 'new', id: inserted.id };
    const existing = await readAction(transaction, input);
    if (!existing) throw new Error('Facebook DM reservation disappeared');
    return existing;
  });
}

export async function settleFacebookCommentAction(
  database: NodePgDatabase,
  input: FacebookCommentActionKey & { reservationId: string; outcome: FacebookCommentOutcome },
): Promise<void> {
  await withTenantTransaction(database, input, async (transaction) => {
    const [updated] = await transaction
      .update(facebookPageCommentActions)
      .set({
        state: input.outcome.state,
        providerCommentId: input.outcome.state === 'confirmed' ? input.outcome.commentId : null,
        failureStatus: input.outcome.state === 'failed' ? input.outcome.failureStatus : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(facebookPageCommentActions.workspaceId, input.workspaceId),
          eq(facebookPageCommentActions.id, input.reservationId),
          eq(facebookPageCommentActions.state, 'reserved'),
        ),
      )
      .returning({ id: facebookPageCommentActions.id });
    if (!updated) throw new Error('Facebook DM settlement lost reservation');
    await transaction.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorType: input.actor.type === 'api-key' ? 'api_key' : input.actor.type,
      actorId: input.actor.id,
      action: 'facebook_page.comment_reply',
      targetType: 'provider_account',
      targetId: input.accountId,
      requestId: input.clientActionId,
      metadata: { outcome: input.outcome.state, commentId: input.commentId },
    });
  });
}
