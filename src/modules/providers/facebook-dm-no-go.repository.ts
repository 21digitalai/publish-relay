import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  engagementProposals,
  facebookPageDmNoGo,
  providerAccounts,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

interface Key {
  workspaceId: string;
  accountId: string;
  conversationId: string;
}

export async function isPageConversationNoGo(database: NodePgDatabase, key: Key): Promise<boolean> {
  return withTenantTransaction(database, key, async (tx) => {
    const [row] = await tx
      .select({ conversationId: facebookPageDmNoGo.conversationId })
      .from(facebookPageDmNoGo)
      .where(
        and(
          eq(facebookPageDmNoGo.workspaceId, key.workspaceId),
          eq(facebookPageDmNoGo.accountId, key.accountId),
          eq(facebookPageDmNoGo.conversationId, key.conversationId),
        ),
      )
      .limit(1);
    return Boolean(row);
  });
}

export async function listPageNoGo(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string },
) {
  return withTenantTransaction(database, input, (tx) =>
    tx
      .select({
        conversationId: facebookPageDmNoGo.conversationId,
        displayName: facebookPageDmNoGo.displayName,
        createdAt: facebookPageDmNoGo.createdAt,
      })
      .from(facebookPageDmNoGo)
      .where(
        and(
          eq(facebookPageDmNoGo.workspaceId, input.workspaceId),
          eq(facebookPageDmNoGo.accountId, input.accountId),
        ),
      )
      .orderBy(facebookPageDmNoGo.createdAt)
      .limit(500),
  );
}

export async function listWorkspacePageNoGo(database: NodePgDatabase, workspaceId: string) {
  return withTenantTransaction(database, { workspaceId }, (tx) =>
    tx
      .select({
        accountId: facebookPageDmNoGo.accountId,
        conversationId: facebookPageDmNoGo.conversationId,
        displayName: facebookPageDmNoGo.displayName,
        accountDisplayName: providerAccounts.displayName,
        createdAt: facebookPageDmNoGo.createdAt,
      })
      .from(facebookPageDmNoGo)
      .innerJoin(
        providerAccounts,
        and(
          eq(providerAccounts.workspaceId, facebookPageDmNoGo.workspaceId),
          eq(providerAccounts.id, facebookPageDmNoGo.accountId),
        ),
      )
      .where(eq(facebookPageDmNoGo.workspaceId, workspaceId))
      .orderBy(facebookPageDmNoGo.createdAt)
      .limit(500),
  );
}

export async function pageNoGoConversationIds(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; conversationIds: string[] },
) {
  if (!input.conversationIds.length) return new Set<string>();
  return withTenantTransaction(database, input, async (tx) => {
    const rows = await tx
      .select({ conversationId: facebookPageDmNoGo.conversationId })
      .from(facebookPageDmNoGo)
      .where(
        and(
          eq(facebookPageDmNoGo.workspaceId, input.workspaceId),
          eq(facebookPageDmNoGo.accountId, input.accountId),
          inArray(facebookPageDmNoGo.conversationId, input.conversationIds),
        ),
      );
    return new Set(rows.map((row) => row.conversationId));
  });
}

export async function setPageConversationNoGo(
  database: NodePgDatabase,
  input: Key & { blocked: boolean; displayName?: string | undefined },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const [account] = await tx
      .select({ provider: providerAccounts.destinationProvider })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.id, input.accountId),
        ),
      )
      .limit(1);
    if (account?.provider !== 'facebook_page') throw new Error('Facebook Page account unavailable');
    if (!input.blocked) {
      await tx
        .delete(facebookPageDmNoGo)
        .where(
          and(
            eq(facebookPageDmNoGo.workspaceId, input.workspaceId),
            eq(facebookPageDmNoGo.accountId, input.accountId),
            eq(facebookPageDmNoGo.conversationId, input.conversationId),
          ),
        );
      return;
    }
    await tx
      .insert(facebookPageDmNoGo)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        displayName: input.displayName?.trim().slice(0, 200) ?? null,
      })
      .onConflictDoNothing();
    await tx
      .update(engagementProposals)
      .set({ status: 'dismissed', updatedAt: new Date() })
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.accountId, input.accountId),
          eq(engagementProposals.provider, 'facebook_page'),
          eq(engagementProposals.kind, 'dm'),
          eq(engagementProposals.targetId, input.conversationId),
          eq(engagementProposals.status, 'pending'),
        ),
      );
  });
}
