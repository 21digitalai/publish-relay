import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  auditEvents,
  memberships,
  providerAccounts,
  providerConnections,
} from '../../database/schema.js';
import type { DiscoveredProviderAccount } from './provider-adapter.js';

export async function assertActiveMembership(
  database: NodePgDatabase,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const rows = await database
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .limit(1);
  if (!rows[0]) throw new Error('Active workspace membership is required');
}

export async function replaceProviderConnection(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    userId: string;
    provider: string;
    credentialId: string;
    accounts: readonly DiscoveredProviderAccount[];
    requestId: string;
  },
): Promise<{ connectionId: string; replacedCredentialId: string | null }> {
  const existing = await database
    .select({ id: providerConnections.id, credentialId: providerConnections.credentialId })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.workspaceId, input.workspaceId),
        eq(providerConnections.provider, input.provider),
      ),
    )
    .limit(1);
  const current = existing[0];
  const connectionRows = current
    ? await database
        .update(providerConnections)
        .set({ credentialId: input.credentialId, status: 'active', updatedAt: new Date() })
        .where(
          and(
            eq(providerConnections.workspaceId, input.workspaceId),
            eq(providerConnections.id, current.id),
          ),
        )
        .returning({ id: providerConnections.id })
    : await database
        .insert(providerConnections)
        .values({
          workspaceId: input.workspaceId,
          provider: input.provider,
          credentialId: input.credentialId,
        })
        .returning({ id: providerConnections.id });
  const connection = connectionRows[0];
  if (!connection) throw new Error('Provider connection write returned no record');
  const existingAccounts = await database
    .select({
      id: providerAccounts.id,
      providerAccountId: providerAccounts.providerAccountId,
    })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.workspaceId, input.workspaceId),
        eq(providerAccounts.connectionId, connection.id),
      ),
    );
  const existingByProviderId = new Map(
    existingAccounts.map((account) => [account.providerAccountId, account.id]),
  );
  const discoveredIds = new Set(input.accounts.map((account) => account.providerAccountId));
  const now = new Date();
  for (const account of existingAccounts) {
    if (!discoveredIds.has(account.providerAccountId))
      await database
        .update(providerAccounts)
        .set({ disconnectedAt: now, updatedAt: now })
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, account.id),
          ),
        );
  }
  for (const account of input.accounts) {
    const existingId = existingByProviderId.get(account.providerAccountId);
    if (!existingId) continue;
    await database
      .update(providerAccounts)
      .set({ displayName: account.displayName, disconnectedAt: null, updatedAt: now })
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.id, existingId),
        ),
      );
  }
  const newAccounts = input.accounts.filter(
    (account) => !existingByProviderId.has(account.providerAccountId),
  );
  if (newAccounts.length > 0)
    await database.insert(providerAccounts).values(
      newAccounts.map((account) => ({
        workspaceId: input.workspaceId,
        connectionId: connection.id,
        providerAccountId: account.providerAccountId,
        displayName: account.displayName,
      })),
    );
  await database.insert(auditEvents).values({
    workspaceId: input.workspaceId,
    actorType: 'user',
    actorId: input.userId,
    action: current ? 'provider.reconnected' : 'provider.connected',
    targetType: 'provider_connection',
    targetId: connection.id,
    requestId: input.requestId,
    metadata: { provider: input.provider, accountCount: input.accounts.length },
  });
  return { connectionId: connection.id, replacedCredentialId: current?.credentialId ?? null };
}
