import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  auditEvents,
  engagementProposals,
  facebookPageDmActions,
  facebookPageDmMemory,
  facebookPageDmPendingIntents,
  facebookPageDmNoGo,
  providerAccounts,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

interface Key {
  workspaceId: string;
  accountId: string;
  conversationId: string;
}

export class CampaignFinalReopenError extends Error {}

export async function isPageConversationNoGo(database: NodePgDatabase, key: Key): Promise<boolean> {
  return (await getPageConversationNoGoReason(database, key)) !== null;
}

export async function getPageConversationNoGoReason(
  database: NodePgDatabase,
  key: Key,
): Promise<'manual' | 'campaign_final' | null> {
  return withTenantTransaction(database, key, async (tx) => {
    const [row] = await tx
      .select({ reason: facebookPageDmNoGo.reason })
      .from(facebookPageDmNoGo)
      .where(
        and(
          eq(facebookPageDmNoGo.workspaceId, key.workspaceId),
          eq(facebookPageDmNoGo.accountId, key.accountId),
          eq(facebookPageDmNoGo.conversationId, key.conversationId),
        ),
      )
      .limit(1);
    return row?.reason === 'campaign_final' ? 'campaign_final' : row ? 'manual' : null;
  });
}

export async function isPageConversationNoGoInTransaction(
  tx: NodePgDatabase,
  key: Key,
): Promise<boolean> {
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
}

export async function lockPageDmAccount(
  tx: NodePgDatabase,
  key: Pick<Key, 'workspaceId' | 'accountId'>,
) {
  const [account] = await tx
    .select({ provider: providerAccounts.destinationProvider })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.workspaceId, key.workspaceId),
        eq(providerAccounts.id, key.accountId),
      ),
    )
    .limit(1)
    .for('update');
  if (account?.provider !== 'facebook_page') throw new Error('Facebook Page account unavailable');
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

export async function listWorkspacePageNoGo(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    beforeCreatedAt?: Date;
    beforeAccountId?: string;
    beforeConversationId?: string;
    limit: number;
  },
) {
  return withTenantTransaction(database, input, (tx) =>
    tx
      .select({
        accountId: facebookPageDmNoGo.accountId,
        conversationId: facebookPageDmNoGo.conversationId,
        displayName: facebookPageDmNoGo.displayName,
        reason: facebookPageDmNoGo.reason,
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
      .where(
        and(
          eq(facebookPageDmNoGo.workspaceId, input.workspaceId),
          ...(input.beforeCreatedAt && input.beforeAccountId && input.beforeConversationId
            ? [
                or(
                  lt(facebookPageDmNoGo.createdAt, input.beforeCreatedAt),
                  and(
                    eq(facebookPageDmNoGo.createdAt, input.beforeCreatedAt),
                    lt(facebookPageDmNoGo.accountId, input.beforeAccountId),
                  ),
                  and(
                    eq(facebookPageDmNoGo.createdAt, input.beforeCreatedAt),
                    eq(facebookPageDmNoGo.accountId, input.beforeAccountId),
                    lt(facebookPageDmNoGo.conversationId, input.beforeConversationId),
                  ),
                ),
              ]
            : []),
        ),
      )
      .orderBy(
        desc(facebookPageDmNoGo.createdAt),
        desc(facebookPageDmNoGo.accountId),
        desc(facebookPageDmNoGo.conversationId),
      )
      .limit(input.limit),
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
    await lockPageDmAccount(tx, input);
    if (!input.blocked) {
      const [existing] = await tx
        .select({ reason: facebookPageDmNoGo.reason })
        .from(facebookPageDmNoGo)
        .where(
          and(
            eq(facebookPageDmNoGo.workspaceId, input.workspaceId),
            eq(facebookPageDmNoGo.accountId, input.accountId),
            eq(facebookPageDmNoGo.conversationId, input.conversationId),
          ),
        )
        .limit(1);
      if (existing?.reason === 'campaign_final')
        throw new CampaignFinalReopenError('Campaign-final conversations require owner reopening');
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
    const cancelled = await tx
      .update(facebookPageDmPendingIntents)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageDmPendingIntents.accountId, input.accountId),
          eq(facebookPageDmPendingIntents.conversationId, input.conversationId),
          inArray(facebookPageDmPendingIntents.status, ['pending', 'waiting']),
        ),
      )
      .returning({
        clientActionId: facebookPageDmPendingIntents.clientActionId,
        groupId: facebookPageDmPendingIntents.groupId,
      });
    if (cancelled.length)
      await tx
        .update(engagementProposals)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(
          and(
            eq(engagementProposals.workspaceId, input.workspaceId),
            or(
              inArray(
                engagementProposals.clientActionId,
                cancelled.map((row) => row.clientActionId),
              ),
              inArray(
                engagementProposals.id,
                cancelled.flatMap((row) => (row.groupId ? [row.groupId] : [])),
              ),
            ),
            eq(engagementProposals.status, 'scheduled'),
          ),
        );
  });
}

/** Clear only a confirmed campaign-final suppression, preserving its action receipt in the ledger. */
export async function reopenCampaignFinalConversation(
  database: NodePgDatabase,
  input: Key & { actorId: string; requestId: string },
): Promise<void> {
  await withTenantTransaction(database, input, async (tx) => {
    await lockPageDmAccount(tx, input);
    const scope = and(
      eq(facebookPageDmNoGo.workspaceId, input.workspaceId),
      eq(facebookPageDmNoGo.accountId, input.accountId),
      eq(facebookPageDmNoGo.conversationId, input.conversationId),
    );
    const [blocked] = await tx
      .select({
        reason: facebookPageDmNoGo.reason,
        finalActionId: facebookPageDmNoGo.finalActionId,
        finalMessageId: facebookPageDmNoGo.finalMessageId,
      })
      .from(facebookPageDmNoGo)
      .where(scope)
      .limit(1);
    if (blocked?.reason !== 'campaign_final' || !blocked.finalActionId || !blocked.finalMessageId)
      throw new CampaignFinalReopenError('Confirmed campaign-final receipt required');
    const [confirmedAction] = await tx
      .select({ id: facebookPageDmActions.id })
      .from(facebookPageDmActions)
      .where(
        and(
          eq(facebookPageDmActions.workspaceId, input.workspaceId),
          eq(facebookPageDmActions.accountId, input.accountId),
          eq(facebookPageDmActions.conversationId, input.conversationId),
          eq(facebookPageDmActions.clientActionId, blocked.finalActionId),
          eq(facebookPageDmActions.providerMessageId, blocked.finalMessageId),
          eq(facebookPageDmActions.state, 'confirmed'),
          eq(facebookPageDmActions.finalExit, true),
        ),
      )
      .limit(1);
    if (!confirmedAction)
      throw new CampaignFinalReopenError('Confirmed campaign-final action receipt required');
    const [unsettledAction] = await tx
      .select({ id: facebookPageDmActions.id })
      .from(facebookPageDmActions)
      .where(
        and(
          eq(facebookPageDmActions.workspaceId, input.workspaceId),
          eq(facebookPageDmActions.accountId, input.accountId),
          eq(facebookPageDmActions.conversationId, input.conversationId),
          inArray(facebookPageDmActions.state, ['reserved', 'unknown']),
        ),
      )
      .limit(1);
    const [unsettledIntent] = await tx
      .select({ id: facebookPageDmPendingIntents.id })
      .from(facebookPageDmPendingIntents)
      .where(
        and(
          eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
          eq(facebookPageDmPendingIntents.accountId, input.accountId),
          eq(facebookPageDmPendingIntents.conversationId, input.conversationId),
          inArray(facebookPageDmPendingIntents.status, [
            'pending',
            'waiting',
            'claimed',
            'unknown',
          ]),
        ),
      )
      .limit(1);
    if (unsettledAction || unsettledIntent)
      throw new CampaignFinalReopenError(
        'Unsettled Page message must be resolved before reopening',
      );
    const [memory] = await tx
      .select({
        finalActionId: facebookPageDmMemory.finalActionId,
        finalMessageId: facebookPageDmMemory.finalMessageId,
      })
      .from(facebookPageDmMemory)
      .where(
        and(
          eq(facebookPageDmMemory.workspaceId, input.workspaceId),
          eq(facebookPageDmMemory.accountId, input.accountId),
          eq(facebookPageDmMemory.conversationId, input.conversationId),
        ),
      )
      .limit(1);
    if (
      memory?.finalActionId !== blocked.finalActionId ||
      memory.finalMessageId !== blocked.finalMessageId
    )
      throw new CampaignFinalReopenError('Campaign-final memory receipt mismatch');
    await tx
      .delete(facebookPageDmNoGo)
      .where(and(scope, eq(facebookPageDmNoGo.reason, 'campaign_final')));
    await tx
      .update(facebookPageDmMemory)
      .set({ terminal: false, updatedAt: new Date() })
      .where(
        and(
          eq(facebookPageDmMemory.workspaceId, input.workspaceId),
          eq(facebookPageDmMemory.accountId, input.accountId),
          eq(facebookPageDmMemory.conversationId, input.conversationId),
        ),
      );
    await tx.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorType: 'user',
      actorId: input.actorId,
      action: 'facebook_page.dm_campaign_final_reopen',
      targetType: 'provider_account',
      targetId: input.accountId,
      requestId: input.requestId,
      metadata: {
        conversationId: input.conversationId,
        finalActionId: blocked.finalActionId,
        finalMessageId: blocked.finalMessageId,
      },
    });
  });
}
