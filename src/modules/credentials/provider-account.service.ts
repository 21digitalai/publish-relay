import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  auditEvents,
  credentials,
  providerAccounts,
  providerConnections,
  publicationJobs,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { z } from 'zod';
import type { youtubeDestinationDefaultsSchema } from '../providers/youtube-settings.js';

export interface ProviderAccountSummary {
  id: string;
  provider: string;
  displayName: string;
  status: string;
  adapterDefaults: unknown;
  updatedAt: Date;
}

export function listProviderAccounts(
  database: NodePgDatabase,
  workspaceId: string,
): Promise<ProviderAccountSummary[]> {
  return withTenantTransaction(database, { workspaceId }, (transaction) =>
    transaction
      .select({
        id: providerAccounts.id,
        provider: providerConnections.provider,
        displayName: providerAccounts.displayName,
        status: providerConnections.status,
        adapterDefaults: providerAccounts.adapterDefaults,
        updatedAt: providerAccounts.updatedAt,
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
        and(eq(providerAccounts.workspaceId, workspaceId), isNull(providerAccounts.disconnectedAt)),
      )
      .orderBy(providerConnections.provider, providerAccounts.displayName),
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
): Promise<'disconnected' | 'missing' | 'scheduled'> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId, userId: input.userId },
    async (transaction) => {
      const rows = await transaction
        .select({
          connectionId: providerAccounts.connectionId,
          credentialId: providerConnections.credentialId,
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
      const activeJobs = await transaction
        .select({ id: publicationJobs.id })
        .from(publicationJobs)
        .where(
          and(
            eq(publicationJobs.workspaceId, input.workspaceId),
            eq(publicationJobs.providerAccountId, input.accountId),
            inArray(publicationJobs.state, ['scheduled', 'leased', 'dispatching', 'retry_wait']),
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
