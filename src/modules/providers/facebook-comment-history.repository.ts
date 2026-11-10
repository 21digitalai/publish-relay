import { and, desc, eq, lt, notExists, or, type AnyColumn } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  facebookPageCommentActions,
  facebookPageCommentPendingIntents,
  providerAccounts,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export interface PageCommentHistoryQuery {
  workspaceId: string;
  accountId?: string | undefined;
  status?: string | undefined;
  beforeCreatedAt?: Date | undefined;
  beforeId?: string | undefined;
  limit: number;
}

function beforeCursor(createdAt: AnyColumn, id: AnyColumn, input: PageCommentHistoryQuery) {
  if (!input.beforeCreatedAt || !input.beforeId) return undefined;
  return or(
    lt(createdAt, input.beforeCreatedAt),
    and(eq(createdAt, input.beforeCreatedAt), lt(id, input.beforeId)),
  );
}

/** A provider post link is safe only for the Page-owned numeric IDs proved by the send path. */
export function pageCommentPostLink(postId: string | null): string | null {
  return postId && /^[0-9]+(?:_[0-9]+)*$/.test(postId)
    ? `https://www.facebook.com/${encodeURIComponent(postId)}`
    : null;
}

export async function listPageCommentHistory(
  database: NodePgDatabase,
  input: PageCommentHistoryQuery,
) {
  return withTenantTransaction(database, input, async (tx) => {
    const actions = await tx
      .select({
        id: facebookPageCommentActions.id,
        accountId: facebookPageCommentActions.accountId,
        accountDisplayName: providerAccounts.displayName,
        postId: facebookPageCommentActions.postId,
        commentId: facebookPageCommentActions.commentId,
        outboundText: facebookPageCommentActions.textBody,
        status: facebookPageCommentActions.state,
        createdAt: facebookPageCommentActions.createdAt,
        updatedAt: facebookPageCommentActions.updatedAt,
      })
      .from(facebookPageCommentActions)
      .innerJoin(
        providerAccounts,
        and(
          eq(providerAccounts.workspaceId, facebookPageCommentActions.workspaceId),
          eq(providerAccounts.id, facebookPageCommentActions.accountId),
        ),
      )
      .where(
        and(
          eq(facebookPageCommentActions.workspaceId, input.workspaceId),
          input.accountId ? eq(facebookPageCommentActions.accountId, input.accountId) : undefined,
          input.status ? eq(facebookPageCommentActions.state, input.status) : undefined,
          beforeCursor(facebookPageCommentActions.createdAt, facebookPageCommentActions.id, input),
        ),
      )
      .orderBy(desc(facebookPageCommentActions.createdAt), desc(facebookPageCommentActions.id))
      .limit(input.limit);
    const pending = await tx
      .select({
        id: facebookPageCommentPendingIntents.id,
        accountId: facebookPageCommentPendingIntents.accountId,
        accountDisplayName: providerAccounts.displayName,
        postId: facebookPageCommentPendingIntents.postId,
        commentId: facebookPageCommentPendingIntents.commentId,
        outboundText: facebookPageCommentPendingIntents.textBody,
        targetText: facebookPageCommentPendingIntents.targetText,
        dueAt: facebookPageCommentPendingIntents.dueAt,
        status: facebookPageCommentPendingIntents.status,
        createdAt: facebookPageCommentPendingIntents.createdAt,
        updatedAt: facebookPageCommentPendingIntents.updatedAt,
      })
      .from(facebookPageCommentPendingIntents)
      .innerJoin(
        providerAccounts,
        and(
          eq(providerAccounts.workspaceId, facebookPageCommentPendingIntents.workspaceId),
          eq(providerAccounts.id, facebookPageCommentPendingIntents.accountId),
        ),
      )
      .where(
        and(
          eq(facebookPageCommentPendingIntents.workspaceId, input.workspaceId),
          input.accountId
            ? eq(facebookPageCommentPendingIntents.accountId, input.accountId)
            : undefined,
          input.status ? eq(facebookPageCommentPendingIntents.status, input.status) : undefined,
          beforeCursor(
            facebookPageCommentPendingIntents.createdAt,
            facebookPageCommentPendingIntents.id,
            input,
          ),
          notExists(
            tx
              .select({ id: facebookPageCommentActions.id })
              .from(facebookPageCommentActions)
              .where(
                and(
                  eq(facebookPageCommentActions.workspaceId, input.workspaceId),
                  eq(
                    facebookPageCommentActions.clientActionId,
                    facebookPageCommentPendingIntents.clientActionId,
                  ),
                ),
              ),
          ),
        ),
      )
      .orderBy(
        desc(facebookPageCommentPendingIntents.createdAt),
        desc(facebookPageCommentPendingIntents.id),
      )
      .limit(input.limit);
    return [
      ...actions.map((row) => ({
        ...row,
        kind: 'send' as const,
        targetText: null,
        dueAt: null,
      })),
      ...pending.map((row) => ({ ...row, kind: 'scheduled' as const })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, input.limit);
  });
}
