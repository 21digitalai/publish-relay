import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  apiKeys,
  auditEvents,
  delegatedGrants,
  facebookPageEngagementGrants,
  facebookPageEngagementModules,
  providerAccounts,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  PAGE_ENGAGEMENT_CAPABILITIES,
  type PageEngagementCapability,
} from './facebook-page-engagement.service.js';

type PrincipalKind = 'api-key' | 'delegated';

export interface PageEngagementPrincipal {
  kind: PrincipalKind;
  id: string;
  label: string;
  capabilities: PageEngagementCapability[];
}

function ownedPage(workspaceId: string, accountId: string) {
  return and(
    eq(providerAccounts.workspaceId, workspaceId),
    eq(providerAccounts.id, accountId),
    eq(providerAccounts.destinationProvider, 'facebook_page'),
    isNull(providerAccounts.disconnectedAt),
  );
}

export async function listPageEngagementPrincipals(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; userId: string },
): Promise<PageEngagementPrincipal[] | null> {
  return withTenantTransaction(database, input, async (transaction) => {
    const [page] = await transaction
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(ownedPage(input.workspaceId, input.accountId))
      .limit(1);
    if (!page) return null;
    const now = new Date();
    const keys = await transaction
      .select({ id: apiKeys.id, label: apiKeys.label })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.workspaceId, input.workspaceId),
          isNull(apiKeys.revokedAt),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
        ),
      )
      .orderBy(apiKeys.createdAt, apiKeys.id)
      .limit(100);
    const grants = await transaction
      .select({ id: delegatedGrants.id, label: delegatedGrants.clientId })
      .from(delegatedGrants)
      .where(
        and(
          eq(delegatedGrants.workspaceId, input.workspaceId),
          eq(delegatedGrants.userId, input.userId),
          isNull(delegatedGrants.revokedAt),
        ),
      )
      .orderBy(delegatedGrants.createdAt, delegatedGrants.id)
      .limit(100);
    const visiblePrincipal = or(
      ...(keys.length
        ? [
            inArray(
              facebookPageEngagementGrants.apiKeyId,
              keys.map((key) => key.id),
            ),
          ]
        : []),
      ...(grants.length
        ? [
            inArray(
              facebookPageEngagementGrants.delegatedGrantId,
              grants.map((grant) => grant.id),
            ),
          ]
        : []),
    );
    const granted = visiblePrincipal
      ? await transaction
          .select({
            apiKeyId: facebookPageEngagementGrants.apiKeyId,
            delegatedGrantId: facebookPageEngagementGrants.delegatedGrantId,
            capability: facebookPageEngagementGrants.capability,
          })
          .from(facebookPageEngagementGrants)
          .where(
            and(
              eq(facebookPageEngagementGrants.workspaceId, input.workspaceId),
              eq(facebookPageEngagementGrants.accountId, input.accountId),
              visiblePrincipal,
            ),
          )
          .limit(1200)
      : [];
    const capabilitiesFor = (kind: PrincipalKind, id: string) =>
      granted
        .filter((row) => (kind === 'api-key' ? row.apiKeyId : row.delegatedGrantId) === id)
        .map((row) => row.capability as PageEngagementCapability);
    return [
      ...keys.map((key) => ({
        kind: 'api-key' as const,
        id: key.id,
        label: key.label,
        capabilities: capabilitiesFor('api-key', key.id),
      })),
      ...grants.map((grant) => ({
        kind: 'delegated' as const,
        id: grant.id,
        label: grant.label,
        capabilities: capabilitiesFor('delegated', grant.id),
      })),
    ];
  });
}

export async function setPageEngagementPrincipalGrants(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    accountId: string;
    userId: string;
    requestId: string;
    principalKind: PrincipalKind;
    principalId: string;
    capabilities: PageEngagementCapability[];
  },
): Promise<boolean> {
  if (
    new Set(input.capabilities).size !== input.capabilities.length ||
    input.capabilities.some((capability) => !PAGE_ENGAGEMENT_CAPABILITIES.includes(capability))
  )
    throw new Error('Invalid Page engagement capabilities');
  return withTenantTransaction(database, input, async (transaction) => {
    const [page] = await transaction
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(ownedPage(input.workspaceId, input.accountId))
      .for('update')
      .limit(1);
    if (!page) return false;
    const principalCriteria =
      input.principalKind === 'api-key'
        ? and(
            eq(apiKeys.workspaceId, input.workspaceId),
            eq(apiKeys.id, input.principalId),
            isNull(apiKeys.revokedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
          )
        : and(
            eq(delegatedGrants.workspaceId, input.workspaceId),
            eq(delegatedGrants.id, input.principalId),
            eq(delegatedGrants.userId, input.userId),
            isNull(delegatedGrants.revokedAt),
          );
    const [principal] =
      input.principalKind === 'api-key'
        ? await transaction
            .select({ id: apiKeys.id })
            .from(apiKeys)
            .where(principalCriteria)
            .limit(1)
        : await transaction
            .select({ id: delegatedGrants.id })
            .from(delegatedGrants)
            .where(principalCriteria)
            .limit(1);
    if (!principal) return false;
    await transaction
      .insert(facebookPageEngagementModules)
      .values({ workspaceId: input.workspaceId, accountId: input.accountId })
      .onConflictDoNothing();
    const principalColumn =
      input.principalKind === 'api-key'
        ? facebookPageEngagementGrants.apiKeyId
        : facebookPageEngagementGrants.delegatedGrantId;
    await transaction
      .delete(facebookPageEngagementGrants)
      .where(
        and(
          eq(facebookPageEngagementGrants.workspaceId, input.workspaceId),
          eq(facebookPageEngagementGrants.accountId, input.accountId),
          eq(principalColumn, input.principalId),
        ),
      );
    if (input.capabilities.length)
      await transaction.insert(facebookPageEngagementGrants).values(
        input.capabilities.map((capability) => ({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          ...(input.principalKind === 'api-key'
            ? { apiKeyId: input.principalId }
            : { delegatedGrantId: input.principalId }),
          capability,
        })),
      );
    await transaction.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorType: 'user',
      actorId: input.userId,
      action: 'provider_account.facebook_engagement_grants_updated',
      targetType: 'provider_account',
      targetId: input.accountId,
      requestId: input.requestId,
      metadata: {
        principalKind: input.principalKind,
        principalId: input.principalId,
        capabilities: input.capabilities,
      },
    });
    return true;
  });
}
