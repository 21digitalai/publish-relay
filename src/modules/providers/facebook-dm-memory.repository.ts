import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { facebookPageDmMemory, providerAccounts } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { readPageDmActiveDayStreaks } from './facebook-dm-active-days.repository.js';

export interface PageDmMemoryKey {
  workspaceId: string;
  accountId: string;
}

export interface PageDmMemoryPatch {
  facts?: string[] | undefined;
  firstContactAt?: Date | null | undefined;
  lastProcessedInboundId?: string | null | undefined;
  lastOutboundReceiptRef?: string | null | undefined;
  terminal?: boolean | undefined;
  unansweredFollowUp?: boolean | undefined;
}

async function requirePageAccount(tx: NodePgDatabase, key: PageDmMemoryKey): Promise<void> {
  const [account] = await tx
    .select({ provider: providerAccounts.destinationProvider })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.workspaceId, key.workspaceId),
        eq(providerAccounts.id, key.accountId),
      ),
    )
    .limit(1);
  if (account?.provider !== 'facebook_page') throw new Error('Facebook Page account unavailable');
}

function emptyMemory(conversationId: string) {
  return {
    conversationId,
    facts: [] as string[],
    firstContactAt: null as Date | null,
    conversationAgeDays: null as number | null,
    lastProcessedInboundId: null as string | null,
    lastOutboundReceiptRef: null as string | null,
    bioLinkMentionAt: null as Date | null,
    bioLinkActionId: null as string | null,
    bioLinkMessageId: null as string | null,
    terminal: false,
    unansweredFollowUp: false,
  };
}

export async function getPageDmMemoryMany(
  database: NodePgDatabase,
  input: PageDmMemoryKey & {
    conversationIds: string[];
    terminal?: 'include' | 'exclude' | 'only' | undefined;
  },
) {
  return withTenantTransaction(database, input, async (tx) => {
    await requirePageAccount(tx, input);
    const rows = await tx
      .select({
        conversationId: facebookPageDmMemory.conversationId,
        facts: facebookPageDmMemory.facts,
        firstContactAt: facebookPageDmMemory.firstContactAt,
        lastProcessedInboundId: facebookPageDmMemory.lastProcessedInboundId,
        lastOutboundReceiptRef: facebookPageDmMemory.lastOutboundReceiptRef,
        bioLinkMentionAt: facebookPageDmMemory.bioLinkMentionAt,
        bioLinkActionId: facebookPageDmMemory.bioLinkActionId,
        bioLinkMessageId: facebookPageDmMemory.bioLinkMessageId,
        terminal: facebookPageDmMemory.terminal,
        unansweredFollowUp: facebookPageDmMemory.unansweredFollowUp,
      })
      .from(facebookPageDmMemory)
      .where(
        and(
          eq(facebookPageDmMemory.workspaceId, input.workspaceId),
          eq(facebookPageDmMemory.accountId, input.accountId),
          inArray(facebookPageDmMemory.conversationId, input.conversationIds),
        ),
      )
      .limit(100);
    const byId = new Map(rows.map((row) => [row.conversationId, row]));
    const now = Date.now();
    const activeDays = await readPageDmActiveDayStreaks(tx, { ...input, now: new Date(now) });
    return input.conversationIds.flatMap((id) => {
      const row = byId.get(id);
      const memory = row
        ? {
            ...row,
            conversationAgeDays: row.firstContactAt
              ? Math.max(0, Math.floor((now - row.firstContactAt.getTime()) / 86_400_000))
              : null,
          }
        : emptyMemory(id);
      if (input.terminal === 'exclude' && memory.terminal) return [];
      if (input.terminal === 'only' && !memory.terminal) return [];
      return [{ ...memory, ...activeDays.get(id) }];
    });
  });
}

/** One bounded Page-local lookup before any per-thread message reads. */
export async function terminalPageConversationIds(
  database: NodePgDatabase,
  input: PageDmMemoryKey & { conversationIds: string[] },
): Promise<Set<string>> {
  if (!input.conversationIds.length) return new Set();
  return withTenantTransaction(database, input, async (tx) => {
    await requirePageAccount(tx, input);
    const rows = await tx
      .select({ conversationId: facebookPageDmMemory.conversationId })
      .from(facebookPageDmMemory)
      .where(
        and(
          eq(facebookPageDmMemory.workspaceId, input.workspaceId),
          eq(facebookPageDmMemory.accountId, input.accountId),
          eq(facebookPageDmMemory.terminal, true),
          inArray(facebookPageDmMemory.conversationId, input.conversationIds),
        ),
      )
      .limit(100);
    return new Set(rows.map((row) => row.conversationId));
  });
}

export async function upsertPageDmMemory(
  database: NodePgDatabase,
  input: PageDmMemoryKey & { conversationId: string; patch: PageDmMemoryPatch },
) {
  return withTenantTransaction(database, input, async (tx) => {
    await requirePageAccount(tx, input);
    const patch = input.patch;
    const values = {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      ...patch,
    };
    const [row] = await tx
      .insert(facebookPageDmMemory)
      .values(values)
      .onConflictDoUpdate({
        target: [
          facebookPageDmMemory.workspaceId,
          facebookPageDmMemory.accountId,
          facebookPageDmMemory.conversationId,
        ],
        set: { ...patch, updatedAt: new Date() },
      })
      .returning({ conversationId: facebookPageDmMemory.conversationId });
    return row;
  });
}
