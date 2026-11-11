import { and, eq, inArray, ne } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  facebookPageDmActions,
  facebookPageDmMemory,
  facebookPageDmPendingIntents,
} from '../../database/schema.js';

/** Caller holds the Page lock; prior confirmed or ambiguous mention must not be repeated. */
export async function hasPageDmBioLinkMention(
  tx: NodePgDatabase,
  input: { workspaceId: string; accountId: string; conversationId: string; clientActionId: string },
): Promise<boolean> {
  const key = [
    eq(facebookPageDmMemory.workspaceId, input.workspaceId),
    eq(facebookPageDmMemory.accountId, input.accountId),
    eq(facebookPageDmMemory.conversationId, input.conversationId),
  ];
  const [memory] = await tx
    .select({ id: facebookPageDmMemory.bioLinkActionId })
    .from(facebookPageDmMemory)
    .where(and(...key))
    .limit(1);
  if (memory?.id && memory.id !== input.clientActionId) return true;
  const [action] = await tx
    .select({ id: facebookPageDmActions.id })
    .from(facebookPageDmActions)
    .where(
      and(
        eq(facebookPageDmActions.workspaceId, input.workspaceId),
        eq(facebookPageDmActions.accountId, input.accountId),
        eq(facebookPageDmActions.conversationId, input.conversationId),
        ne(facebookPageDmActions.clientActionId, input.clientActionId),
        eq(facebookPageDmActions.bioLinkMention, true),
        inArray(facebookPageDmActions.state, ['reserved', 'unknown', 'confirmed']),
      ),
    )
    .limit(1);
  if (action) return true;
  const [pending] = await tx
    .select({ id: facebookPageDmPendingIntents.id })
    .from(facebookPageDmPendingIntents)
    .where(
      and(
        eq(facebookPageDmPendingIntents.workspaceId, input.workspaceId),
        eq(facebookPageDmPendingIntents.accountId, input.accountId),
        eq(facebookPageDmPendingIntents.conversationId, input.conversationId),
        ne(facebookPageDmPendingIntents.clientActionId, input.clientActionId),
        eq(facebookPageDmPendingIntents.bioLinkMention, true),
        inArray(facebookPageDmPendingIntents.status, ['pending', 'waiting', 'claimed', 'unknown']),
      ),
    )
    .limit(1);
  return Boolean(pending);
}
