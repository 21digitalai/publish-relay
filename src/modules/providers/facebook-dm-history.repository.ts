import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  engagementProposals,
  facebookPageDmActions,
  providerAccounts,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export interface PageDmHistoryQuery {
  workspaceId: string;
  accountId?: string | undefined;
  conversationId?: string | undefined;
  beforeCreatedAt?: Date | undefined;
  beforeId?: string | undefined;
  limit: number;
}

export async function getPageDmSendAction(
  database: NodePgDatabase,
  workspaceId: string,
  id: string,
) {
  return withTenantTransaction(database, { workspaceId }, async (tx) => {
    const [row] = await tx
      .select({
        accountId: facebookPageDmActions.accountId,
        conversationId: facebookPageDmActions.conversationId,
      })
      .from(facebookPageDmActions)
      .where(
        and(eq(facebookPageDmActions.workspaceId, workspaceId), eq(facebookPageDmActions.id, id)),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function listPageDmHistory(database: NodePgDatabase, input: PageDmHistoryQuery) {
  return withTenantTransaction(database, input, async (tx) => {
    const cursor =
      input.beforeCreatedAt && input.beforeId
        ? { createdAt: input.beforeCreatedAt, id: input.beforeId }
        : null;
    const proposals = await tx
      .select({
        id: engagementProposals.id,
        accountId: engagementProposals.accountId,
        conversationId: engagementProposals.targetId,
        status: engagementProposals.status,
        sourceContext: engagementProposals.sourceContext,
        createdAt: engagementProposals.createdAt,
        updatedAt: engagementProposals.updatedAt,
        accountDisplayName: providerAccounts.displayName,
      })
      .from(engagementProposals)
      .innerJoin(
        providerAccounts,
        and(
          eq(providerAccounts.workspaceId, engagementProposals.workspaceId),
          eq(providerAccounts.id, engagementProposals.accountId),
        ),
      )
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.provider, 'facebook_page'),
          eq(engagementProposals.kind, 'dm'),
          ...(input.accountId ? [eq(engagementProposals.accountId, input.accountId)] : []),
          ...(input.conversationId ? [eq(engagementProposals.targetId, input.conversationId)] : []),
          ...(cursor
            ? [
                or(
                  lt(engagementProposals.createdAt, cursor.createdAt),
                  and(
                    eq(engagementProposals.createdAt, cursor.createdAt),
                    lt(engagementProposals.id, cursor.id),
                  ),
                ),
              ]
            : []),
        ),
      )
      .orderBy(desc(engagementProposals.createdAt), desc(engagementProposals.id))
      .limit(input.limit);
    const actions = await tx
      .select({
        id: facebookPageDmActions.id,
        accountId: facebookPageDmActions.accountId,
        conversationId: facebookPageDmActions.conversationId,
        receiverLabel: facebookPageDmActions.receiverLabel,
        outboundText: facebookPageDmActions.textBody,
        status: facebookPageDmActions.state,
        createdAt: facebookPageDmActions.createdAt,
        updatedAt: facebookPageDmActions.updatedAt,
        accountDisplayName: providerAccounts.displayName,
      })
      .from(facebookPageDmActions)
      .innerJoin(
        providerAccounts,
        and(
          eq(providerAccounts.workspaceId, facebookPageDmActions.workspaceId),
          eq(providerAccounts.id, facebookPageDmActions.accountId),
        ),
      )
      .where(
        and(
          eq(facebookPageDmActions.workspaceId, input.workspaceId),
          ...(input.accountId ? [eq(facebookPageDmActions.accountId, input.accountId)] : []),
          ...(input.conversationId
            ? [eq(facebookPageDmActions.conversationId, input.conversationId)]
            : []),
          ...(cursor
            ? [
                or(
                  lt(facebookPageDmActions.createdAt, cursor.createdAt),
                  and(
                    eq(facebookPageDmActions.createdAt, cursor.createdAt),
                    lt(facebookPageDmActions.id, cursor.id),
                  ),
                ),
              ]
            : []),
        ),
      )
      .orderBy(desc(facebookPageDmActions.createdAt), desc(facebookPageDmActions.id))
      .limit(input.limit);
    return [
      ...proposals.map((row) => ({
        id: row.id,
        kind: 'proposal' as const,
        accountId: row.accountId,
        accountDisplayName: row.accountDisplayName,
        conversationId: row.conversationId,
        receiverLabel:
          typeof row.sourceContext === 'object' &&
          row.sourceContext !== null &&
          'authorLabel' in row.sourceContext &&
          typeof row.sourceContext.authorLabel === 'string'
            ? row.sourceContext.authorLabel.slice(0, 200)
            : null,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      ...actions.map((row) => ({ ...row, kind: 'send' as const })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, input.limit);
  });
}
