import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  auditEvents,
  facebookPageEngagementGrants,
  facebookPageEngagementModules,
  providerAccounts,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export const PAGE_ENGAGEMENT_CAPABILITIES = [
  'comments:read',
  'comments:propose',
  'comments:send',
  'dms:read',
  'dms:propose',
  'dms:send',
] as const;
export type PageEngagementCapability = (typeof PAGE_ENGAGEMENT_CAPABILITIES)[number];
export type PageEngagementModule = 'comments' | 'dms';
export type ProviderGrantEvidence = 'unknown' | 'missing' | 'verified';

export interface PageEngagementState {
  comments: { localEnabled: boolean; providerGrant: ProviderGrantEvidence };
  dms: { localEnabled: boolean; providerGrant: ProviderGrantEvidence };
}

function pageAccountCriteria(workspaceId: string, accountId: string) {
  return and(
    eq(providerAccounts.workspaceId, workspaceId),
    eq(providerAccounts.id, accountId),
    eq(providerAccounts.destinationProvider, 'facebook_page'),
    isNull(providerAccounts.disconnectedAt),
  );
}

export async function readPageEngagementState(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string },
): Promise<PageEngagementState | null> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const [account] = await transaction
        .select({ id: providerAccounts.id })
        .from(providerAccounts)
        .where(pageAccountCriteria(input.workspaceId, input.accountId))
        .limit(1);
      if (!account) return null;
      const [modules] = await transaction
        .select()
        .from(facebookPageEngagementModules)
        .where(
          and(
            eq(facebookPageEngagementModules.workspaceId, input.workspaceId),
            eq(facebookPageEngagementModules.accountId, input.accountId),
          ),
        )
        .limit(1);
      return {
        comments: {
          localEnabled: modules?.commentsEnabled ?? false,
          providerGrant: (modules?.commentsProviderGrant ?? 'unknown') as ProviderGrantEvidence,
        },
        dms: {
          localEnabled: modules?.dmsEnabled ?? false,
          providerGrant: (modules?.dmsProviderGrant ?? 'unknown') as ProviderGrantEvidence,
        },
      };
    },
  );
}

export async function setPageEngagementModule(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    accountId: string;
    userId: string;
    requestId: string;
    module: PageEngagementModule;
    enabled: boolean;
  },
): Promise<PageEngagementState | null> {
  const found = await withTenantTransaction(
    database,
    { workspaceId: input.workspaceId, userId: input.userId },
    async (transaction) => {
      const [account] = await transaction
        .select({ id: providerAccounts.id })
        .from(providerAccounts)
        .where(pageAccountCriteria(input.workspaceId, input.accountId))
        .for('update')
        .limit(1);
      if (!account) return false;
      await transaction
        .insert(facebookPageEngagementModules)
        .values({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          ...(input.module === 'comments'
            ? { commentsEnabled: input.enabled }
            : { dmsEnabled: input.enabled }),
        })
        .onConflictDoUpdate({
          target: [
            facebookPageEngagementModules.workspaceId,
            facebookPageEngagementModules.accountId,
          ],
          set: {
            ...(input.module === 'comments'
              ? { commentsEnabled: input.enabled }
              : { dmsEnabled: input.enabled }),
            updatedAt: new Date(),
          },
        });
      await transaction.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.userId,
        action: 'provider_account.facebook_engagement_module_updated',
        targetType: 'provider_account',
        targetId: input.accountId,
        requestId: input.requestId,
        metadata: {
          module: input.module,
          localEnabled: input.enabled,
          providerGrantVerified: false,
        },
      });
      return true;
    },
  );
  if (!found) return null;
  return readPageEngagementState(database, input);
}

// This is the future provider-call boundary. A workspace-wide key capability,
// delegated scope, or exposed Page is never sufficient for engagement access.
export async function authorizePageEngagement(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    accountId: string;
    principal: { kind: 'api-key' | 'delegated'; actorId: string; workspaceId: string };
    capability: PageEngagementCapability;
  },
): Promise<boolean> {
  if (input.principal.workspaceId !== input.workspaceId) return false;
  const module = input.capability.startsWith('comments:') ? 'comments' : 'dms';
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const [result] = await transaction
        .select({
          enabled:
            module === 'comments'
              ? facebookPageEngagementModules.commentsEnabled
              : facebookPageEngagementModules.dmsEnabled,
          providerGrant:
            module === 'comments'
              ? facebookPageEngagementModules.commentsProviderGrant
              : facebookPageEngagementModules.dmsProviderGrant,
        })
        .from(providerAccounts)
        .innerJoin(
          facebookPageEngagementModules,
          and(
            eq(facebookPageEngagementModules.workspaceId, providerAccounts.workspaceId),
            eq(facebookPageEngagementModules.accountId, providerAccounts.id),
          ),
        )
        .innerJoin(
          facebookPageEngagementGrants,
          and(
            eq(facebookPageEngagementGrants.workspaceId, providerAccounts.workspaceId),
            eq(facebookPageEngagementGrants.accountId, providerAccounts.id),
            eq(facebookPageEngagementGrants.capability, input.capability),
            input.principal.kind === 'api-key'
              ? eq(facebookPageEngagementGrants.apiKeyId, input.principal.actorId)
              : eq(facebookPageEngagementGrants.delegatedGrantId, input.principal.actorId),
          ),
        )
        .where(pageAccountCriteria(input.workspaceId, input.accountId))
        .limit(1);
      return result?.enabled === true && result.providerGrant === 'verified';
    },
  );
}
