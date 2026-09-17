import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  auditEvents,
  memberships,
  providerAccounts,
  providerConnections,
} from '../../database/schema.js';
import type { DiscoveredProviderAccount } from './provider-adapter.js';
import type { DestinationProvider } from '../providers/contract.js';

interface NormalizedDestination extends DiscoveredProviderAccount {
  destinationProvider: DestinationProvider;
  remoteAccountId: string;
}

function normalizeDestination(
  connectionFamily: string,
  account: DiscoveredProviderAccount,
): NormalizedDestination {
  const destinationProvider = (account.destinationProvider ??
    connectionFamily) as DestinationProvider;
  return {
    ...account,
    destinationProvider,
    remoteAccountId: account.remoteAccountId ?? account.providerAccountId,
  };
}

function destinationKey(destinationProvider: DestinationProvider, remoteAccountId: string): string {
  return `${destinationProvider}:${remoteAccountId}`;
}

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
  const destinations = input.accounts.map((account) =>
    normalizeDestination(input.provider, account),
  );
  const existingAccounts = await database
    .select({
      id: providerAccounts.id,
      destinationProvider: providerAccounts.destinationProvider,
      remoteAccountId: providerAccounts.remoteAccountId,
    })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.workspaceId, input.workspaceId),
        eq(providerAccounts.connectionId, connection.id),
      ),
    );
  const existingByDestination = new Map(
    existingAccounts.map((account) => [
      destinationKey(account.destinationProvider as DestinationProvider, account.remoteAccountId),
      account.id,
    ]),
  );
  const discoveredKeys = new Set(
    destinations.map((account) =>
      destinationKey(account.destinationProvider, account.remoteAccountId),
    ),
  );
  const now = new Date();
  for (const account of existingAccounts) {
    if (
      !discoveredKeys.has(
        destinationKey(account.destinationProvider as DestinationProvider, account.remoteAccountId),
      )
    )
      await database
        .update(providerAccounts)
        .set({ availability: 'remote_missing', disconnectedAt: now, updatedAt: now })
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, account.id),
          ),
        );
  }
  for (const account of destinations) {
    const existingId = existingByDestination.get(
      destinationKey(account.destinationProvider, account.remoteAccountId),
    );
    if (!existingId) continue;
    await database
      .update(providerAccounts)
      .set({
        providerAccountId: account.providerAccountId,
        displayName: account.displayName,
        remoteParentAccountId: account.remoteParentAccountId ?? null,
        credentialId: account.credentialId ?? null,
        capabilitySnapshot: account.capabilitySnapshot ?? {},
        capabilitiesCheckedAt: account.capabilitiesCheckedAt ?? null,
        availability: 'active',
        disconnectedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.id, existingId),
        ),
      );
  }
  const newAccounts = destinations.filter(
    (account) =>
      !existingByDestination.has(
        destinationKey(account.destinationProvider, account.remoteAccountId),
      ),
  );
  if (newAccounts.length > 0)
    await database.insert(providerAccounts).values(
      newAccounts.map((account) => ({
        workspaceId: input.workspaceId,
        connectionId: connection.id,
        providerAccountId: account.providerAccountId,
        destinationProvider: account.destinationProvider,
        remoteAccountId: account.remoteAccountId,
        remoteParentAccountId: account.remoteParentAccountId ?? null,
        credentialId: account.credentialId ?? null,
        capabilitySnapshot: account.capabilitySnapshot ?? {},
        capabilitiesCheckedAt: account.capabilitiesCheckedAt ?? null,
        availability: 'active',
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
