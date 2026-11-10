import { isDeepStrictEqual } from 'node:util';

import { and, desc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  engagementProposals,
  providerAccounts,
  providerConnections,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  isPageConversationNoGoInTransaction,
  lockPageDmAccount,
} from './facebook-dm-no-go.repository.js';

export type ProposalKind = 'dm' | 'comment';
export interface ProposalContent {
  text: string;
  followUps?: [string, string];
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
  plannedDueAt?: Date | undefined;
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

/** Expiry never touches an approved schedule or a send already in progress. */
async function expirePendingScheduledProposals(
  database: NodePgDatabase,
  now: Date,
  workspaceId?: string,
): Promise<number> {
  const rows = await database
    .update(engagementProposals)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(engagementProposals.status, 'pending'),
        eq(engagementProposals.provider, 'facebook_page'),
        eq(engagementProposals.kind, 'dm'),
        lte(engagementProposals.plannedDueAt, now),
        ...(workspaceId ? [eq(engagementProposals.workspaceId, workspaceId)] : []),
      ),
    )
    .returning({ id: engagementProposals.id });
  return rows.length;
}

export async function expireScheduledEngagementProposals(
  database: NodePgDatabase,
  now = new Date(),
): Promise<number> {
  return expirePendingScheduledProposals(database, now);
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
    (existing.plannedDueAt?.toISOString() ?? null) ===
      (input.plannedDueAt?.toISOString() ?? null) &&
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
    if (input.provider === 'facebook_page' && input.kind === 'dm') {
      await lockPageDmAccount(tx, input);
      if (
        await isPageConversationNoGoInTransaction(tx, {
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          conversationId: input.targetId.trim(),
        })
      )
        throw new EngagementProposalError('This Page conversation is on the no-go list', 409);
      const sameConversation = and(
        eq(engagementProposals.workspaceId, input.workspaceId),
        eq(engagementProposals.accountId, input.accountId),
        eq(engagementProposals.provider, 'facebook_page'),
        eq(engagementProposals.kind, 'dm'),
        eq(engagementProposals.targetId, input.targetId.trim()),
      );
      const now = new Date();
      await tx
        .update(engagementProposals)
        .set({ status: 'expired', updatedAt: now })
        .where(
          and(
            sameConversation,
            eq(engagementProposals.status, 'pending'),
            lte(engagementProposals.plannedDueAt, now),
          ),
        );
      const [active] = await tx
        .select({ id: engagementProposals.id })
        .from(engagementProposals)
        .where(
          and(
            sameConversation,
            inArray(engagementProposals.status, ['pending', 'scheduled', 'sending', 'unknown']),
          ),
        )
        .limit(1);
      if (active)
        throw new EngagementProposalError(
          'This conversation already has an active or unresolved proposal',
          409,
        );
      await tx
        .update(engagementProposals)
        .set({ status: 'superseded', updatedAt: now })
        .where(and(sameConversation, eq(engagementProposals.status, 'expired')));
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
        plannedDueAt: input.plannedDueAt,
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

export async function listEngagementReviewQueue(
  database: NodePgDatabase,
  workspaceId: string,
  page?: {
    beforeCreatedAt?: Date;
    beforeId?: string;
    provider?: 'facebook_page' | 'fanvue';
    kind?: 'dm' | 'comment';
    view?: 'review' | 'history' | 'attention';
    limit: number;
  },
) {
  return withTenantTransaction(database, { workspaceId }, async (tx) => {
    await expirePendingScheduledProposals(tx, new Date(), workspaceId);
    const rows = await tx
      .select({ proposal: engagementProposals, accountDisplayName: providerAccounts.displayName })
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
          eq(engagementProposals.workspaceId, workspaceId),
          inArray(
            engagementProposals.status,
            page?.view === 'review'
              ? ['pending']
              : page?.view === 'history'
                ? ['scheduled']
                : page?.view === 'attention'
                  ? ['sending', 'cancelled', 'unknown', 'failed', 'expired', 'superseded']
                  : [
                      'pending',
                      'sending',
                      'scheduled',
                      'cancelled',
                      'unknown',
                      'failed',
                      'expired',
                      'superseded',
                    ],
          ),
          ...(page?.provider ? [eq(engagementProposals.provider, page.provider)] : []),
          ...(page?.kind ? [eq(engagementProposals.kind, page.kind)] : []),
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
      .limit(page?.limit ?? 100);
    return rows.map((row) => ({ ...row.proposal, accountDisplayName: row.accountDisplayName }));
  });
}

export async function getEngagementProposal(
  database: NodePgDatabase,
  workspaceId: string,
  id: string,
) {
  return withTenantTransaction(database, { workspaceId }, async (tx) => {
    await expirePendingScheduledProposals(tx, new Date(), workspaceId);
    const [row] = await tx
      .select({ proposal: engagementProposals, accountDisplayName: providerAccounts.displayName })
      .from(engagementProposals)
      .innerJoin(
        providerAccounts,
        and(
          eq(providerAccounts.workspaceId, engagementProposals.workspaceId),
          eq(providerAccounts.id, engagementProposals.accountId),
        ),
      )
      .where(and(eq(engagementProposals.workspaceId, workspaceId), eq(engagementProposals.id, id)))
      .limit(1);
    return row ? { ...row.proposal, accountDisplayName: row.accountDisplayName } : null;
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
          inArray(engagementProposals.status, ['pending', 'expired', 'superseded']),
        ),
      )
      .returning();
    if (!row) throw new EngagementProposalError('Proposal is stale or unavailable', 409);
    return row;
  });
}

/** One transaction claims an exact reviewed revision before any provider side effect. */
export async function claimEngagementProposal(
  database: NodePgDatabase,
  input: { workspaceId: string; id: string; expectedRevision: number },
) {
  return withTenantTransaction(database, { workspaceId: input.workspaceId }, async (tx) => {
    const [selected] = await tx
      .select({
        proposal: engagementProposals,
        availability: providerAccounts.availability,
        disconnectedAt: providerAccounts.disconnectedAt,
        connectionStatus: providerConnections.status,
        revokedAt: providerConnections.revokedAt,
      })
      .from(engagementProposals)
      .innerJoin(
        providerAccounts,
        and(
          eq(providerAccounts.workspaceId, engagementProposals.workspaceId),
          eq(providerAccounts.id, engagementProposals.accountId),
        ),
      )
      .innerJoin(
        providerConnections,
        and(
          eq(providerConnections.workspaceId, providerAccounts.workspaceId),
          eq(providerConnections.id, providerAccounts.connectionId),
        ),
      )
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.id),
        ),
      )
      .for('update')
      .limit(1);
    if (
      selected?.proposal.status !== 'pending' ||
      selected.proposal.revision !== input.expectedRevision
    )
      throw new EngagementProposalError('Proposal is stale or unavailable', 409);
    if (
      selected.availability !== 'active' ||
      selected.disconnectedAt ||
      selected.connectionStatus !== 'active' ||
      selected.revokedAt
    )
      throw new EngagementProposalError('Proposal destination is unavailable', 409);
    const [claimed] = await tx
      .update(engagementProposals)
      .set({ status: 'sending', updatedAt: new Date() })
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.id),
          eq(engagementProposals.status, 'pending'),
          eq(engagementProposals.revision, input.expectedRevision),
        ),
      )
      .returning();
    if (!claimed) throw new EngagementProposalError('Proposal is stale or unavailable', 409);
    return claimed;
  });
}

/** Roll back only a proven pre-send failure; no provider request or intent exists. */
export async function releaseEngagementProposalClaim(
  database: NodePgDatabase,
  input: { workspaceId: string; id: string; clientActionId: string; expectedRevision: number },
) {
  return withTenantTransaction(database, { workspaceId: input.workspaceId }, async (tx) => {
    const [released] = await tx
      .update(engagementProposals)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.id),
          eq(engagementProposals.clientActionId, input.clientActionId),
          eq(engagementProposals.revision, input.expectedRevision),
          eq(engagementProposals.status, 'sending'),
        ),
      )
      .returning();
    if (!released) throw new EngagementProposalError('Proposal send is stale or unavailable', 409);
    return released;
  });
}

/** A lost settlement leaves sending visible and must never authorize an automatic resend. */
export async function settleEngagementProposal(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    id: string;
    clientActionId: string;
    expectedRevision: number;
    status: 'sent' | 'failed' | 'unknown';
  },
) {
  return withTenantTransaction(database, { workspaceId: input.workspaceId }, async (tx) => {
    const [settled] = await tx
      .update(engagementProposals)
      .set({ status: input.status, updatedAt: new Date() })
      .where(
        and(
          eq(engagementProposals.workspaceId, input.workspaceId),
          eq(engagementProposals.id, input.id),
          eq(engagementProposals.clientActionId, input.clientActionId),
          eq(engagementProposals.revision, input.expectedRevision),
          eq(engagementProposals.status, 'sending'),
        ),
      )
      .returning();
    if (!settled) throw new EngagementProposalError('Proposal send is stale or unavailable', 409);
    return settled;
  });
}
