import { and, desc, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  instagramUnifiedActions,
  instagramUnifiedDmNoGo,
  instagramUnifiedPendingIntents,
  providerAccounts,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export interface InstagramUnifiedConversationKey {
  workspaceId: string;
  accountId: string;
  conversationId: string;
}

export async function isInstagramUnifiedConversationNoGo(
  database: NodePgDatabase,
  key: InstagramUnifiedConversationKey,
) {
  return withTenantTransaction(database, key, async (tx) => {
    const [row] = await tx
      .select({ conversationId: instagramUnifiedDmNoGo.conversationId })
      .from(instagramUnifiedDmNoGo)
      .where(
        and(
          eq(instagramUnifiedDmNoGo.workspaceId, key.workspaceId),
          eq(instagramUnifiedDmNoGo.accountId, key.accountId),
          eq(instagramUnifiedDmNoGo.conversationId, key.conversationId),
        ),
      )
      .limit(1);
    return Boolean(row);
  });
}

export async function setInstagramUnifiedConversationNoGo(
  database: NodePgDatabase,
  input: InstagramUnifiedConversationKey & { blocked: boolean; displayName?: string },
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
      .for('update')
      .limit(1);
    if (account?.provider !== 'instagram_unified_login')
      throw new Error('Unified Instagram account unavailable');
    const scope = and(
      eq(instagramUnifiedDmNoGo.workspaceId, input.workspaceId),
      eq(instagramUnifiedDmNoGo.accountId, input.accountId),
      eq(instagramUnifiedDmNoGo.conversationId, input.conversationId),
    );
    if (!input.blocked) {
      await tx.delete(instagramUnifiedDmNoGo).where(scope);
      return;
    }
    await tx
      .insert(instagramUnifiedDmNoGo)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        conversationId: input.conversationId,
        displayName: input.displayName?.trim().slice(0, 200) ?? null,
      })
      .onConflictDoNothing();
    const cancelled = await tx
      .update(instagramUnifiedPendingIntents)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(instagramUnifiedPendingIntents.workspaceId, input.workspaceId),
          eq(instagramUnifiedPendingIntents.accountId, input.accountId),
          eq(instagramUnifiedPendingIntents.parentId, input.conversationId),
          eq(instagramUnifiedPendingIntents.kind, 'dm_reply'),
          inArray(instagramUnifiedPendingIntents.status, ['pending']),
        ),
      )
      .returning({ clientActionId: instagramUnifiedPendingIntents.clientActionId });
    return { cancelled: cancelled.length };
  });
}

export async function listInstagramUnifiedConversationHistory(
  database: NodePgDatabase,
  input: InstagramUnifiedConversationKey & { limit?: number },
) {
  return withTenantTransaction(database, input, async (tx) => {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const actions = await tx
      .select({
        id: instagramUnifiedActions.id,
        kind: instagramUnifiedActions.kind,
        targetId: instagramUnifiedActions.targetId,
        text: instagramUnifiedActions.textBody,
        status: instagramUnifiedActions.state,
        receipt: instagramUnifiedActions.providerReceipt,
        createdAt: instagramUnifiedActions.createdAt,
        updatedAt: instagramUnifiedActions.updatedAt,
      })
      .from(instagramUnifiedActions)
      .where(
        and(
          eq(instagramUnifiedActions.workspaceId, input.workspaceId),
          eq(instagramUnifiedActions.accountId, input.accountId),
          eq(instagramUnifiedActions.parentId, input.conversationId),
        ),
      )
      .orderBy(desc(instagramUnifiedActions.createdAt))
      .limit(limit);
    const pending = await tx
      .select({
        id: instagramUnifiedPendingIntents.id,
        kind: instagramUnifiedPendingIntents.kind,
        targetId: instagramUnifiedPendingIntents.targetId,
        text: instagramUnifiedPendingIntents.textBody,
        status: instagramUnifiedPendingIntents.status,
        receipt: instagramUnifiedPendingIntents.id,
        createdAt: instagramUnifiedPendingIntents.createdAt,
        updatedAt: instagramUnifiedPendingIntents.updatedAt,
      })
      .from(instagramUnifiedPendingIntents)
      .where(
        and(
          eq(instagramUnifiedPendingIntents.workspaceId, input.workspaceId),
          eq(instagramUnifiedPendingIntents.accountId, input.accountId),
          eq(instagramUnifiedPendingIntents.parentId, input.conversationId),
        ),
      )
      .orderBy(desc(instagramUnifiedPendingIntents.createdAt))
      .limit(limit);
    return [...actions, ...pending]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  });
}
