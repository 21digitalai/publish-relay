import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { fanvueActionIntents, providerAccounts } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export interface FanvueActionHistoryQuery {
  workspaceId: string;
  accountId?: string | undefined;
  kind?: 'message' | 'comment' | undefined;
  status?: string | undefined;
  beforeCreatedAt?: Date | undefined;
  beforeId?: string | undefined;
  limit: number;
}

/** The action ledger is send truth; no proposal row can imply provider dispatch. */
export async function listFanvueActionHistory(
  database: NodePgDatabase,
  input: FanvueActionHistoryQuery,
) {
  return withTenantTransaction(database, input, (tx) =>
    tx
      .select({
        id: fanvueActionIntents.id,
        accountId: fanvueActionIntents.accountId,
        accountDisplayName: providerAccounts.displayName,
        kind: fanvueActionIntents.actionKind,
        outboundText: fanvueActionIntents.textBody,
        targetLabel: fanvueActionIntents.targetLabel,
        mediaCount: fanvueActionIntents.mediaCount,
        priceCents: fanvueActionIntents.priceCents,
        status: fanvueActionIntents.state,
        providerReceipt: fanvueActionIntents.providerObjectUuid,
        createdAt: fanvueActionIntents.createdAt,
        updatedAt: fanvueActionIntents.updatedAt,
      })
      .from(fanvueActionIntents)
      .innerJoin(
        providerAccounts,
        and(
          eq(providerAccounts.workspaceId, fanvueActionIntents.workspaceId),
          eq(providerAccounts.id, fanvueActionIntents.accountId),
        ),
      )
      .where(
        and(
          eq(fanvueActionIntents.workspaceId, input.workspaceId),
          input.accountId ? eq(fanvueActionIntents.accountId, input.accountId) : undefined,
          input.kind
            ? eq(fanvueActionIntents.actionKind, input.kind)
            : inArray(fanvueActionIntents.actionKind, ['message', 'comment']),
          input.status ? eq(fanvueActionIntents.state, input.status) : undefined,
          input.beforeCreatedAt && input.beforeId
            ? or(
                lt(fanvueActionIntents.createdAt, input.beforeCreatedAt),
                and(
                  eq(fanvueActionIntents.createdAt, input.beforeCreatedAt),
                  lt(fanvueActionIntents.id, input.beforeId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(fanvueActionIntents.createdAt), desc(fanvueActionIntents.id))
      .limit(input.limit),
  );
}
