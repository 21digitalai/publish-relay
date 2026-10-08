import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  auditEvents,
  credentials,
  providerAccounts,
  providerConnections,
  publicationJobs,
  workspaces,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { z } from 'zod';
import type { youtubeDestinationDefaultsSchema } from '../providers/youtube-settings.js';
import {
  capabilityFreshness,
  destinationCapabilities,
  type DestinationCapabilitySnapshot,
} from '../providers/destination-capabilities.js';

export interface ProviderAccountSummary {
  id: string;
  provider: string;
  destinationProvider: string;
  displayName: string;
  status: string;
  availability: string;
  remoteParentAccountId: string | null;
  capabilitySnapshot: DestinationCapabilitySnapshot;
  capabilitiesCheckedAt: Date | null;
  capabilityFreshness: 'fresh' | 'stale' | 'unknown';
  adapterDefaults: unknown;
  xLongPosts: { allowed: boolean; source: 'self_declared'; verified: false } | null;
  updatedAt: Date;
  expiresAt?: Date | null;
}

export function listProviderAccounts(
  database: NodePgDatabase,
  workspaceId: string,
): Promise<ProviderAccountSummary[]> {
  return withTenantTransaction(database, { workspaceId }, async (transaction) => {
    const rows = await transaction
      .select({
        id: providerAccounts.id,
        provider: providerConnections.provider,
        grantFamily: providerConnections.grantFamily,
        destinationProvider: providerAccounts.destinationProvider,
        displayName: providerAccounts.displayName,
        status: providerConnections.status,
        availability: providerAccounts.availability,
        remoteParentAccountId: providerAccounts.remoteParentAccountId,
        capabilitiesCheckedAt: providerAccounts.capabilitiesCheckedAt,
        adapterDefaults: providerAccounts.adapterDefaults,
        xLongPostsAllowed: providerAccounts.xLongPostsAllowed,
        updatedAt: providerAccounts.updatedAt,
        expiresAt: providerConnections.expiresAt,
        disconnectedAt: providerAccounts.disconnectedAt,
        accessExpiresAt: providerConnections.accessExpiresAt,
        refreshExpiresAt: providerConnections.refreshExpiresAt,
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
          eq(providerAccounts.workspaceId, workspaceId),
          or(isNull(providerAccounts.disconnectedAt), eq(providerConnections.provider, 'tiktok')),
        ),
      )
      .orderBy(providerConnections.provider, providerAccounts.displayName);
    return rows.map(
      ({ accessExpiresAt, refreshExpiresAt, disconnectedAt, xLongPostsAllowed, ...row }) => ({
        ...row,
        xLongPosts:
          row.destinationProvider === 'x'
            ? {
                allowed: xLongPostsAllowed,
                source: 'self_declared' as const,
                verified: false as const,
              }
            : null,
        status:
          disconnectedAt && row.provider === 'tiktok'
            ? 'disconnected'
            : row.provider === 'tiktok' && row.status === 'active'
              ? refreshExpiresAt && refreshExpiresAt.getTime() <= Date.now()
                ? 'renewal_required'
                : accessExpiresAt && accessExpiresAt.getTime() <= Date.now()
                  ? 'expired'
                  : 'active'
              : row.status,
        capabilitySnapshot: destinationCapabilities(row.destinationProvider),
        capabilityFreshness: capabilityFreshness(row.capabilitiesCheckedAt),
      }),
    );
  });
}

export async function updateXLongPostDeclaration(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    userId: string;
    accountId: string;
    requestId: string;
    allowed: boolean;
  },
): Promise<'updated' | 'missing'> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId, userId: input.userId },
    async (transaction) => {
      const rows = await transaction
        .select({ id: providerAccounts.id, allowed: providerAccounts.xLongPostsAllowed })
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
            eq(providerAccounts.destinationProvider, 'x'),
            eq(providerConnections.provider, 'x'),
            eq(providerConnections.status, 'active'),
            isNull(providerAccounts.disconnectedAt),
          ),
        )
        .for('update')
        .limit(1);
      if (!rows[0]) return 'missing';
      if (rows[0].allowed === input.allowed) return 'updated';
      await transaction
        .update(providerAccounts)
        .set({ xLongPostsAllowed: input.allowed, updatedAt: new Date() })
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, input.accountId),
          ),
        );
      await transaction.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.userId,
        action: 'provider_account.x_long_posts_declaration_updated',
        targetType: 'provider_account',
        targetId: input.accountId,
        requestId: input.requestId,
        metadata: {
          provider: 'x',
          allowed: input.allowed,
          source: 'self_declared',
          verified: false,
        },
      });
      return 'updated';
    },
  );
}

export async function updateYouTubeAccountDefaults(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    userId: string;
    accountId: string;
    requestId: string;
    defaults: z.infer<typeof youtubeDestinationDefaultsSchema>;
  },
): Promise<'updated' | 'missing'> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId, userId: input.userId },
    async (transaction) => {
      const accounts = await transaction
        .select({ id: providerAccounts.id })
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
            eq(providerConnections.provider, 'youtube'),
            eq(providerConnections.status, 'active'),
            isNull(providerAccounts.disconnectedAt),
          ),
        )
        .limit(1);
      if (!accounts[0]) return 'missing';
      await transaction
        .update(providerAccounts)
        .set({ adapterDefaults: input.defaults, updatedAt: new Date() })
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, input.accountId),
          ),
        );
      await transaction.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.userId,
        action: 'provider_account.defaults_updated',
        targetType: 'provider_account',
        targetId: input.accountId,
        requestId: input.requestId,
        metadata: { provider: 'youtube' },
      });
      return 'updated';
    },
  );
}

export async function disconnectProviderAccount(
  database: NodePgDatabase,
  input: { workspaceId: string; userId: string; accountId: string; requestId: string },
): Promise<'disconnected' | 'missing' | 'scheduled' | 'revoking'> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId, userId: input.userId },
    async (transaction) => {
      await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId))
        .for('update');
      const rows = await transaction
        .select({
          connectionId: providerAccounts.connectionId,
          credentialId: providerConnections.credentialId,
          connectionStatus: providerConnections.status,
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
        .limit(1);
      const account = rows[0];
      if (!account) return 'missing';
      if (account.connectionStatus === 'revoking') return 'revoking';
      const activeJobs = await transaction
        .select({ id: publicationJobs.id })
        .from(publicationJobs)
        .where(
          and(
            eq(publicationJobs.workspaceId, input.workspaceId),
            eq(publicationJobs.providerAccountId, input.accountId),
            or(
              inArray(publicationJobs.state, [
                'scheduled',
                'leased',
                'dispatching',
                'accepted_pending',
                'retry_wait',
              ]),
              eq(publicationJobs.reconciliationRequired, true),
            ),
          ),
        )
        .limit(1);
      if (activeJobs[0]) return 'scheduled';
      await transaction
        .update(providerAccounts)
        .set({ disconnectedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, input.accountId),
          ),
        );
      const remaining = await transaction
        .select({ id: providerAccounts.id })
        .from(providerAccounts)
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.connectionId, account.connectionId),
            isNull(providerAccounts.disconnectedAt),
          ),
        )
        .limit(1);
      if (!remaining[0]) {
        await transaction
          .update(providerConnections)
          .set({ status: 'disconnected', updatedAt: new Date() })
          .where(
            and(
              eq(providerConnections.workspaceId, input.workspaceId),
              eq(providerConnections.id, account.connectionId),
            ),
          );
        await transaction
          .update(credentials)
          .set({ revokedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(credentials.workspaceId, input.workspaceId),
              eq(credentials.id, account.credentialId),
            ),
          );
      }
      await transaction.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.userId,
        action: 'provider_account.disconnected',
        targetType: 'provider_account',
        targetId: input.accountId,
        requestId: input.requestId,
        metadata: {},
      });
      return 'disconnected';
    },
  );
}
