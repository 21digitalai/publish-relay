import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  auditEvents,
  apiKeys,
  delegatedGrants,
  facebookPageEngagementGrants,
  facebookPageEngagementModules,
  providerAccounts,
  registeredClients,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { getActiveCredential } from '../credentials/credential.repository.js';
import { PAGE_ENGAGEMENT_CAPABILITIES } from '../identity/api-key.js';

export { PAGE_ENGAGEMENT_CAPABILITIES };
export type PageEngagementCapability = (typeof PAGE_ENGAGEMENT_CAPABILITIES)[number];
export type PageEngagementModule = 'comments' | 'dms';
export type ProviderGrantEvidence = 'unknown' | 'missing' | 'verified';

export interface PageEngagementState {
  comments: { localEnabled: boolean; providerGrant: ProviderGrantEvidence };
  dms: { localEnabled: boolean; providerGrant: ProviderGrantEvidence };
  dmDailyGroupLimitEnabled: boolean;
  dmDailyGroupMaximum: 1 | 2;
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
        .select({ id: providerAccounts.id, credentialId: providerAccounts.credentialId })
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
      const messagesCredentialActive = modules?.dmsCredentialId
        ? Boolean(
            await getActiveCredential(transaction, input.workspaceId, modules.dmsCredentialId),
          )
        : false;
      const commentsCredentialActive = modules?.commentsCredentialId
        ? Boolean(
            await getActiveCredential(transaction, input.workspaceId, modules.commentsCredentialId),
          )
        : false;
      return {
        dmDailyGroupLimitEnabled: modules?.dmDailyGroupLimitEnabled ?? false,
        dmDailyGroupMaximum: modules?.dmDailyGroupMaximum === 2 ? 2 : 1,
        comments: {
          localEnabled: modules?.commentsEnabled ?? false,
          providerGrant: (modules
            ? modules.commentsCredentialId && commentsCredentialActive
              ? modules.commentsProviderGrant
              : 'missing'
            : 'unknown') as ProviderGrantEvidence,
        },
        dms: {
          localEnabled: modules?.dmsEnabled ?? false,
          providerGrant: (modules
            ? modules.dmsCredentialId === account.credentialId && messagesCredentialActive
              ? modules.dmsProviderGrant
              : 'missing'
            : 'unknown') as ProviderGrantEvidence,
        },
      };
    },
  );
}

/** Owner-controlled Page-local autonomous group cap; unrelated Pages default off. */
export async function setPageDmDailyGroupLimit(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    accountId: string;
    userId: string;
    requestId: string;
    enabled: boolean;
    maximum: 1 | 2;
  },
): Promise<PageEngagementState | null> {
  const found = await withTenantTransaction(database, input, async (tx) => {
    const [account] = await tx
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(pageAccountCriteria(input.workspaceId, input.accountId))
      .for('update')
      .limit(1);
    if (!account) return false;
    await tx
      .insert(facebookPageEngagementModules)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        dmDailyGroupLimitEnabled: input.enabled,
        dmDailyGroupMaximum: input.maximum,
      })
      .onConflictDoUpdate({
        target: [
          facebookPageEngagementModules.workspaceId,
          facebookPageEngagementModules.accountId,
        ],
        set: {
          dmDailyGroupLimitEnabled: input.enabled,
          dmDailyGroupMaximum: input.maximum,
          updatedAt: new Date(),
        },
      });
    await tx.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorType: 'user',
      actorId: input.userId,
      action: 'provider_account.dm_daily_group_limit_updated',
      targetType: 'provider_account',
      targetId: input.accountId,
      requestId: input.requestId,
      metadata: { enabled: input.enabled, maximum: input.maximum },
    });
    return true;
  });
  return found ? readPageEngagementState(database, input) : null;
}

export async function isPageDmDailyGroupLimitEnabled(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string },
): Promise<boolean> {
  return withTenantTransaction(database, input, (tx) =>
    isPageDmDailyGroupLimitEnabledInTransaction(tx, input),
  );
}

export async function isPageDmDailyGroupLimitEnabledInTransaction(
  tx: NodePgDatabase,
  input: { workspaceId: string; accountId: string },
): Promise<boolean> {
  const [row] = await tx
    .select({ enabled: facebookPageEngagementModules.dmDailyGroupLimitEnabled })
    .from(facebookPageEngagementModules)
    .where(
      and(
        eq(facebookPageEngagementModules.workspaceId, input.workspaceId),
        eq(facebookPageEngagementModules.accountId, input.accountId),
      ),
    )
    .limit(1);
  return row?.enabled ?? false;
}

export async function getPageDmDailyGroupLimitInTransaction(
  tx: NodePgDatabase,
  input: { workspaceId: string; accountId: string },
): Promise<{ enabled: boolean; maximum: 1 | 2 }> {
  const [row] = await tx
    .select({
      enabled: facebookPageEngagementModules.dmDailyGroupLimitEnabled,
      maximum: facebookPageEngagementModules.dmDailyGroupMaximum,
    })
    .from(facebookPageEngagementModules)
    .where(
      and(
        eq(facebookPageEngagementModules.workspaceId, input.workspaceId),
        eq(facebookPageEngagementModules.accountId, input.accountId),
      ),
    )
    .limit(1);
  return { enabled: row?.enabled ?? false, maximum: row?.maximum === 2 ? 2 : 1 };
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
  const module = input.capability.startsWith('facebook:guidance:')
    ? null
    : input.capability.startsWith('comments:')
      ? 'comments'
      : 'dms';
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const [active] =
        input.principal.kind === 'api-key'
          ? await transaction
              .select({ scopes: apiKeys.capabilities })
              .from(apiKeys)
              .where(
                and(
                  eq(apiKeys.workspaceId, input.workspaceId),
                  eq(apiKeys.id, input.principal.actorId),
                  isNull(apiKeys.revokedAt),
                  or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
                ),
              )
              .limit(1)
          : await transaction
              .select({ scopes: delegatedGrants.scopes, allowed: registeredClients.allowedScopes })
              .from(delegatedGrants)
              .innerJoin(registeredClients, eq(delegatedGrants.clientId, registeredClients.id))
              .where(
                and(
                  eq(delegatedGrants.workspaceId, input.workspaceId),
                  eq(delegatedGrants.id, input.principal.actorId),
                  isNull(delegatedGrants.revokedAt),
                ),
              )
              .limit(1);
      if (!active?.scopes.includes(input.capability)) return false;
      if (
        'allowed' in active &&
        (!Array.isArray(active.allowed) || !active.allowed.includes(input.capability))
      )
        return false;
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
          dmsCredentialId: facebookPageEngagementModules.dmsCredentialId,
          commentsCredentialId: facebookPageEngagementModules.commentsCredentialId,
          accountCredentialId: providerAccounts.credentialId,
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
      if (!result) return false;
      // Page guidance is account-local context; it does not require either optional
      // provider consent. Its explicit Page-local principal grant remains mandatory.
      if (module === null) return true;
      if (!result.enabled || result.providerGrant !== 'verified') return false;
      if (module === 'comments')
        return (
          result.commentsCredentialId !== null &&
          Boolean(
            await getActiveCredential(transaction, input.workspaceId, result.commentsCredentialId),
          )
        );
      return (
        result.dmsCredentialId === result.accountCredentialId &&
        result.dmsCredentialId !== null &&
        Boolean(await getActiveCredential(transaction, input.workspaceId, result.dmsCredentialId))
      );
    },
  );
}
