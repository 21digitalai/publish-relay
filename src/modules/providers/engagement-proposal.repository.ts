import { isDeepStrictEqual } from 'node:util';

import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { engagementProposals, providerAccounts } from '../../database/schema.js';
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

export async function createEngagementProposal(
  database: NodePgDatabase,
  input: CreateEngagementProposal,
) {
  if (!input.targetId.trim() || !input.content.text.trim())
    throw new Error('Proposal target and text are required');
  return withTenantTransaction(database, { workspaceId: input.workspaceId }, async (tx) => {
    const [account] = await tx
      .select({
        provider: providerAccounts.destinationProvider,
        availability: providerAccounts.availability,
        disconnectedAt: providerAccounts.disconnectedAt,
      })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.id, input.accountId),
        ),
      )
      .limit(1);
    if (!account) throw new Error('Proposal destination is unavailable');
    if (
      account.provider !== input.provider ||
      account.availability !== 'active' ||
      account.disconnectedAt
    ) {
      throw new Error('Proposal destination is unavailable');
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
    if (!existing) throw new Error('Proposal action ID conflicts with a different request');
    if (
      existing.accountId !== input.accountId ||
      existing.provider !== input.provider ||
      existing.kind !== input.kind ||
      existing.targetId !== input.targetId.trim() ||
      existing.proposerType !== input.proposerType ||
      existing.proposerId !== input.proposerId ||
      !isDeepStrictEqual(existing.content, input.content) ||
      !isDeepStrictEqual(existing.sourceContext, input.sourceContext ?? {})
    ) {
      throw new Error('Proposal action ID conflicts with a different request');
    }
    return existing;
  });
}

export async function listPendingEngagementProposals(
  database: NodePgDatabase,
  workspaceId: string,
) {
  return withTenantTransaction(database, { workspaceId }, (tx) =>
    tx
      .select()
      .from(engagementProposals)
      .where(
        and(
          eq(engagementProposals.workspaceId, workspaceId),
          eq(engagementProposals.status, 'pending'),
        ),
      )
      .orderBy(desc(engagementProposals.createdAt), desc(engagementProposals.id))
      .limit(100),
  );
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
  if (!input.content.text.trim()) throw new Error('Proposal text is required');
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
    if (!row) throw new Error('Proposal is stale or unavailable');
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
    if (!row) throw new Error('Proposal is stale or unavailable');
    return row;
  });
}
