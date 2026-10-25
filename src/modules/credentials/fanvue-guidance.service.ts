import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { auditEvents, providerAccounts, providerConnections } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';

export const FANVUE_GUIDANCE_LIMIT = 10_000;

interface GuidanceAccount {
  workspaceId: string;
  accountId: string;
}

export interface GuidanceActor {
  type: 'user' | 'api_key' | 'delegated';
  id: string;
}

export async function getFanvueGuidance(
  database: NodePgDatabase,
  input: GuidanceAccount,
): Promise<string | null> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const [row] = await transaction
        .select({ guidance: providerAccounts.fanvueAgentGuidance })
        .from(providerAccounts)
        .innerJoin(
          providerConnections,
          and(
            eq(providerConnections.workspaceId, providerAccounts.workspaceId),
            eq(providerConnections.id, providerAccounts.connectionId),
          ),
        )
        .where(activeFanvueAccount(input))
        .limit(1);
      return row?.guidance ?? null;
    },
  );
}

export async function updateFanvueGuidance(
  database: NodePgDatabase,
  input: GuidanceAccount & { guidance: string; actor: GuidanceActor; requestId: string },
): Promise<string | null> {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const [row] = await transaction
        .select({ guidance: providerAccounts.fanvueAgentGuidance })
        .from(providerAccounts)
        .innerJoin(
          providerConnections,
          and(
            eq(providerConnections.workspaceId, providerAccounts.workspaceId),
            eq(providerConnections.id, providerAccounts.connectionId),
          ),
        )
        .where(activeFanvueAccount(input))
        .for('update')
        .limit(1);
      if (!row) return null;
      if (row.guidance === input.guidance) return row.guidance;
      await transaction
        .update(providerAccounts)
        .set({ fanvueAgentGuidance: input.guidance, updatedAt: new Date() })
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
        action: 'provider_account.fanvue_guidance_updated',
        targetType: 'provider_account',
        targetId: input.accountId,
        requestId: input.requestId,
        metadata: { provider: 'fanvue', length: Array.from(input.guidance).length },
      });
      return input.guidance;
    },
  );
}

function activeFanvueAccount(input: GuidanceAccount) {
  return and(
    eq(providerAccounts.workspaceId, input.workspaceId),
    eq(providerAccounts.id, input.accountId),
    eq(providerAccounts.destinationProvider, 'fanvue'),
    eq(providerConnections.provider, 'fanvue'),
    eq(providerConnections.status, 'active'),
    eq(providerAccounts.availability, 'active'),
    isNull(providerAccounts.disconnectedAt),
  );
}
