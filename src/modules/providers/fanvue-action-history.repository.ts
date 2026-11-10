import { and, desc, eq, inArray, lt, notExists, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  fanvueActionIntents,
  fanvueDmPendingIntents,
  providerAccounts,
} from '../../database/schema.js';
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
  return withTenantTransaction(database, input, async (tx) => {
    const actionRows = await tx
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
          input.status
            ? ['reserved', 'confirmed', 'failed', 'unknown'].includes(input.status)
              ? eq(fanvueActionIntents.state, input.status)
              : undefined
            : undefined,
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
      .limit(
        input.status && !['reserved', 'confirmed', 'failed', 'unknown'].includes(input.status)
          ? 0
          : input.limit,
      );
    const pendingRows =
      input.kind === 'comment' ||
      (input.status &&
        !['pending', 'claimed', 'cancelled', 'failed', 'unknown'].includes(input.status))
        ? []
        : await tx
            .select({
              id: fanvueDmPendingIntents.id,
              accountId: fanvueDmPendingIntents.accountId,
              accountDisplayName: providerAccounts.displayName,
              outboundText: fanvueDmPendingIntents.textBody,
              targetLabel: fanvueDmPendingIntents.targetLabel,
              mediaIds: fanvueDmPendingIntents.mediaIds,
              priceCents: fanvueDmPendingIntents.priceCents,
              status: fanvueDmPendingIntents.status,
              dueAt: fanvueDmPendingIntents.dueAt,
              createdAt: fanvueDmPendingIntents.createdAt,
              updatedAt: fanvueDmPendingIntents.updatedAt,
            })
            .from(fanvueDmPendingIntents)
            .innerJoin(
              providerAccounts,
              and(
                eq(providerAccounts.workspaceId, fanvueDmPendingIntents.workspaceId),
                eq(providerAccounts.id, fanvueDmPendingIntents.accountId),
              ),
            )
            .where(
              and(
                eq(fanvueDmPendingIntents.workspaceId, input.workspaceId),
                input.accountId ? eq(fanvueDmPendingIntents.accountId, input.accountId) : undefined,
                input.status
                  ? eq(fanvueDmPendingIntents.status, input.status)
                  : inArray(fanvueDmPendingIntents.status, [
                      'pending',
                      'claimed',
                      'cancelled',
                      'failed',
                      'unknown',
                    ]),
                notExists(
                  tx
                    .select({ id: fanvueActionIntents.id })
                    .from(fanvueActionIntents)
                    .where(
                      and(
                        eq(fanvueActionIntents.workspaceId, fanvueDmPendingIntents.workspaceId),
                        eq(
                          fanvueActionIntents.clientActionId,
                          fanvueDmPendingIntents.clientActionId,
                        ),
                      ),
                    ),
                ),
                input.beforeCreatedAt && input.beforeId
                  ? or(
                      lt(fanvueDmPendingIntents.createdAt, input.beforeCreatedAt),
                      and(
                        eq(fanvueDmPendingIntents.createdAt, input.beforeCreatedAt),
                        lt(fanvueDmPendingIntents.id, input.beforeId),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(desc(fanvueDmPendingIntents.createdAt), desc(fanvueDmPendingIntents.id))
            .limit(input.limit);
    const merged = [
      ...actionRows.map((row) => ({ ...row, dueAt: null as Date | null })),
      ...pendingRows.map((row) => ({
        id: row.id,
        accountId: row.accountId,
        accountDisplayName: row.accountDisplayName,
        kind: 'message',
        outboundText: row.outboundText,
        targetLabel: row.targetLabel,
        mediaCount: row.mediaIds.length,
        priceCents: row.priceCents,
        status: row.status,
        providerReceipt: null,
        dueAt: row.dueAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    ];
    merged.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
    );
    return merged.slice(0, input.limit);
  });
}
