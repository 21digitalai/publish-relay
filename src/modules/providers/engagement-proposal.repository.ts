import { isDeepStrictEqual } from 'node:util';

import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  engagementProposals,
  providerAccounts,
  providerConnections,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export type ProposalKind = 'dm' | 'comment';
export interface ProposalContent {
  text: string;
  mediaIds?: string[];
  priceCents?: number;
}

export interface CreateEngagementProposal {
  workspaceId: string;
  accountId: string;
  clientActionId: string;
  provider: string;
  kind: ProposalKind;
  targetId: string;
  sourceContext?: Record<string, unknown>;
  content: ProposalContent;
  proposerType: 'user' | 'api_key' | 'delegated';
  proposerId: string;
}

export class EngagementProposalError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 409,
  ) {
    super(message);
  }
}

function matchesProposal(
  existing: typeof engagementProposals.$inferSelect,
  input: CreateEngagementProposal,
): boolean {
  return (
    existing.accountId === input.accountId &&
    existing.provider === input.provider &&
    existing.kind === input.kind &&
    existing.targetId === input.targetId.trim() &&
    existing.proposerType === input.proposerType &&
    existing.proposerId === input.proposerId &&
    isDeepStrictEqual(existing.content, input.content) &&
    isDeepStrictEqual(existing.sourceContext, input.sourceContext ?? {})
  );
}

export async function createEngagementProposal(
  database: NodePgDatabase,
  input: CreateEngagementProposal,
) {
  if (!input.targetId.trim() || !input.content.text.trim())
    throw new EngagementProposalError('Proposal target and text are required', 400);
  return withTenantTransaction(database, { workspaceId: input.workspaceId }, async (tx) => {
    const [prior] = await tx
      .select()
      .from(engagementProposals)
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    if (prior) {
      if (!matchesProposal(prior, input))
        throw new EngagementProposalError(
          'Proposal action ID conflicts with a different request',
          409,
        );
      return prior;
    }
    const [account] = await tx
      .select({
        provider: providerAccounts.destinationProvider,
        availability: providerAccounts.availability,
        disconnectedAt: providerAccounts.disconnectedAt,
        connectionStatus: providerConnections.status,
        connectionRevokedAt: providerConnections.revokedAt,
      })
      .from(providerAccounts)
      .innerJoin(
        providerConnections,
        and(
          eq(providerConnections.workspaceId, providerAccounts.workspaceId),
          eq(providerConnections.id, providerAccounts.connectionId),
        ),
      )
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.id, input.accountId),
        ),
      )
      .limit(1)
      .for('update');
    if (!account) throw new EngagementProposalError('Proposal destination is unavailable', 409);
    if (
      account.provider !== input.provider ||
      account.availability !== 'active' ||
      account.disconnectedAt ||
      account.connectionStatus !== 'active' ||
      account.connectionRevokedAt
    ) {
      throw new EngagementProposalError('Proposal destination is unavailable', 409);
    }
    const [created] = await tx
      .insert(engagementProposals)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        clientActionId: input.clientActionId,
        provider: input.provider,
        kind: input.kind,
        targetId: input.targetId.trim(),
        sourceContext: input.sourceContext ?? {},
        content: input.content,
        proposerType: input.proposerType,
        proposerId: input.proposerId,
      })
      .onConflictDoNothing({
        target: [engagementProposals.workspaceId, engagementProposals.clientActionId],
      })
      .returning();
    if (created) return created;
    const [existing] = await tx
      .select()
      .from(engagementProposals)
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.clientActionId, input.clientActionId),
        ),
      )
      .limit(1);
    if (!existing)
      throw new EngagementProposalError(
        'Proposal action ID conflicts with a different request',
        409,
      );
    if (!matchesProposal(existing, input)) {
      throw new EngagementProposalError(
        'Proposal action ID conflicts with a different request',
        409,
      );
    }
    return existing;
  });
}

export async function listPendingEngagementProposals(
  database: NodePgDatabase,
  workspaceId: string,
  page?: { beforeCreatedAt?: Date; beforeId?: string; limit: number },
) {
  return withTenantTransaction(database, { workspaceId }, (tx) =>
    tx
      .select()
      .from(engagementProposals)
      .where(
        and(
          eq(engagementProposals.workspaceId, workspaceId),
          eq(engagementProposals.status, 'pending'),
          ...(page?.beforeCreatedAt && page.beforeId
            ? [
                or(
                  lt(engagementProposals.createdAt, page.beforeCreatedAt),
                  and(
                    eq(engagementProposals.createdAt, page.beforeCreatedAt),
                    lt(engagementProposals.id, page.beforeId),
                  ),
                ),
              ]
            : []),
        ),
      )
      .orderBy(desc(engagementProposals.createdAt), desc(engagementProposals.id))
      .limit(page?.limit ?? 100),
  );
}

export async function getEngagementProposal(
  database: NodePgDatabase,
  workspaceId: string,
  id: string,
) {
  return withTenantTransaction(database, { workspaceId }, async (tx) => {
    const [row] = await tx
      .select()
      .from(engagementProposals)
      .where(and(eq(engagementProposals.workspaceId, workspaceId), eq(engagementProposals.id, id)))
      .limit(1);
    return row ?? null;
  });
}

export async function reviseEngagementProposal(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    id: string;
    expectedRevision: number;
    content: ProposalContent;
  },
) {
  if (!input.content.text.trim())
    throw new EngagementProposalError('Proposal text is required', 400);
  return withTenantTransaction(database, { workspaceId: input.workspaceId }, async (tx) => {
    const [row] = await tx
      .update(engagementProposals)
      .set({
        content: input.content,
        revision: sql`${engagementProposals.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.id),
          eq(engagementProposals.revision, input.expectedRevision),
          eq(engagementProposals.status, 'pending'),
        ),
      )
      .returning();
    if (!row) throw new EngagementProposalError('Proposal is stale or unavailable', 409);
    return row;
  });
}

export async function dismissEngagementProposal(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    id: string;
    expectedRevision: number;
  },
) {
  return withTenantTransaction(database, { workspaceId: input.workspaceId }, async (tx) => {
    const [row] = await tx
      .update(engagementProposals)
      .set({
        status: 'dismissed',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.id),
          eq(engagementProposals.revision, input.expectedRevision),
          eq(engagementProposals.status, 'pending'),
        ),
      )
      .returning();
    if (!row) throw new EngagementProposalError('Proposal is stale or unavailable', 409);
    return row;
  });
}
