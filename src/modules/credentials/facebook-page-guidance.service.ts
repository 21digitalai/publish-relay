import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { auditEvents, providerAccounts, providerConnections } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export const PAGE_GUIDANCE_LIMIT = 10_000;

export interface PageGuidance {
  profile: string;
  dmGuidance: string;
  commentGuidance: string;
}

interface PageAccount {
  workspaceId: string;
  accountId: string;
}

interface GuidanceActor {
  type: 'user' | 'api_key' | 'delegated';
  id: string;
}

function activePage(input: PageAccount) {
  return and(
    eq(providerAccounts.workspaceId, input.workspaceId),
    eq(providerAccounts.id, input.accountId),
    eq(providerAccounts.destinationProvider, 'facebook_page'),
    eq(providerConnections.provider, 'meta'),
    eq(providerConnections.status, 'active'),
    eq(providerAccounts.availability, 'active'),
    isNull(providerAccounts.disconnectedAt),
  );
}

const fields = {
  profile: providerAccounts.facebookPageProfile,
  dmGuidance: providerAccounts.facebookPageDmGuidance,
  commentGuidance: providerAccounts.facebookPageCommentGuidance,
};

export async function getFacebookPageGuidance(
  database: NodePgDatabase,
  input: PageAccount,
): Promise<PageGuidance | null> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const [row] = await transaction
        .select(fields)
        .from(providerAccounts)
        .innerJoin(
          providerConnections,
          and(
            eq(providerConnections.workspaceId, providerAccounts.workspaceId),
            eq(providerConnections.id, providerAccounts.connectionId),
          ),
        )
        .where(activePage(input))
        .limit(1);
      return row ?? null;
    },
  );
}

export async function updateFacebookPageGuidance(
  database: NodePgDatabase,
  input: PageAccount & PageGuidance & { actor: GuidanceActor; requestId: string },
): Promise<PageGuidance | null> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const [current] = await transaction
        .select(fields)
        .from(providerAccounts)
        .innerJoin(
          providerConnections,
          and(
            eq(providerConnections.workspaceId, providerAccounts.workspaceId),
            eq(providerConnections.id, providerAccounts.connectionId),
          ),
        )
        .where(activePage(input))
        .for('update')
        .limit(1);
      if (!current) return null;
      const next = {
        profile: input.profile,
        dmGuidance: input.dmGuidance,
        commentGuidance: input.commentGuidance,
      };
      if (
        Object.keys(next).every(
          (key) => current[key as keyof PageGuidance] === next[key as keyof PageGuidance],
        )
      )
        return current;
      await transaction
        .update(providerAccounts)
        .set({
          facebookPageProfile: next.profile,
          facebookPageDmGuidance: next.dmGuidance,
          facebookPageCommentGuidance: next.commentGuidance,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, input.accountId),
          ),
        );
      await transaction.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'provider_account.facebook_page_guidance_updated',
        targetType: 'provider_account',
        targetId: input.accountId,
        requestId: input.requestId,
        metadata: {
          profileLength: Array.from(next.profile).length,
          dmLength: Array.from(next.dmGuidance).length,
          commentLength: Array.from(next.commentGuidance).length,
        },
      });
      return next;
    },
  );
}
