import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  auditEvents,
  memberships,
  providerAccounts,
  providerConnections,
  workspaces,
} from '../../database/schema.js';
import type { DiscoveredProviderAccount } from './provider-adapter.js';
import type { DestinationProvider } from '../providers/contract.js';

interface NormalizedDestination extends DiscoveredProviderAccount {
  destinationProvider: DestinationProvider;
  remoteAccountId: string;
}

export class ProviderDestinationConflictError extends Error {
  public constructor() {
    super('Provider destination belongs to another connection; manual resolution required');
  }
}

function normalizeDestination(
  connectionFamily: string,
  account: DiscoveredProviderAccount,
): NormalizedDestination {
  const destinationProvider = (account.destinationProvider ??
    connectionFamily) as DestinationProvider;
  const allowedDestinations: Readonly<Record<string, readonly string[]>> = {
    x: ['x'],
    youtube: ['youtube'],
    meta: ['instagram', 'facebook_page'],
    instagram_login: ['instagram'],
    tiktok: ['tiktok'],
  };
  const allowed = allowedDestinations[connectionFamily];
  if (allowed && !allowed.includes(destinationProvider))
    throw new Error(
      `Destination provider ${destinationProvider} is incompatible with connection family ${connectionFamily}`,
    );
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

export async function getLinkedInMemberForAccount(
  database: NodePgDatabase,
  workspaceId: string,
  accountId: string,
): Promise<string | null> {
  const rows = await database
    .select({ memberUrn: providerConnections.memberUrn })
    .from(providerAccounts)
    .innerJoin(providerConnections, eq(providerAccounts.connectionId, providerConnections.id))
    .where(
      and(
        eq(providerAccounts.workspaceId, workspaceId),
        eq(providerAccounts.id, accountId),
        eq(providerConnections.workspaceId, workspaceId),
        eq(providerConnections.provider, 'linkedin'),
      ),
    )
    .limit(1);
  return rows[0]?.memberUrn ?? null;
}

export async function replaceProviderConnection(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    userId: string;
    provider: string;
    grantFamily?: 'facebook_pages' | 'instagram';
    credentialId: string;
    accounts: readonly DiscoveredProviderAccount[];
    requestId: string;
    expiresAt?: Date;
    externalSubjectId?: string;
    scopes?: readonly string[];
    accessExpiresAt?: Date;
    refreshExpiresAt?: Date;
  },
): Promise<{
  connectionId: string;
  replacedCredentialId: string | null;
  replacedAccountCredentialIds: string[];
}> {
  const memberUrn = input.provider === 'linkedin' ? input.accounts[0]?.providerAccountId : null;
  if (
    input.provider === 'linkedin' &&
    (input.accounts.length !== 1 || !memberUrn?.startsWith('urn:li:person:'))
  )
    throw new Error('LinkedIn connection must identify exactly one member');
  if (
    input.provider === 'tiktok' &&
    (!input.externalSubjectId ||
      input.accounts.length !== 1 ||
      input.accounts[0]?.providerAccountId !== input.externalSubjectId)
  )
    throw new Error('TikTok connection must identify exactly one stable provider subject');
  const subjectId = input.externalSubjectId ?? memberUrn;
  if (!subjectId || subjectId.startsWith('legacy:'))
    throw new Error('Provider connection requires a verified principal subject');
  const destinations = input.accounts.map((account) =>
    normalizeDestination(input.provider, account),
  );
  if (
    input.provider === 'meta' &&
    input.grantFamily &&
    destinations.some((destination) =>
      input.grantFamily === 'facebook_pages'
        ? destination.destinationProvider !== 'facebook_page'
        : destination.destinationProvider !== 'instagram',
    )
  )
    throw new Error('Meta destination does not match the consent family');
  // Serialize grants in one workspace so two principals cannot claim a destination.
  await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .for('update');
  const existing = await database
    .select({
      id: providerConnections.id,
      credentialId: providerConnections.credentialId,
      externalSubjectId: providerConnections.externalSubjectId,
      status: providerConnections.status,
    })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.workspaceId, input.workspaceId),
        eq(providerConnections.provider, input.provider),
        eq(providerConnections.externalSubjectId, subjectId),
        input.grantFamily
          ? eq(providerConnections.grantFamily, input.grantFamily)
          : isNull(providerConnections.grantFamily),
      ),
    )
    .for('update')
    .limit(1);
  const current = existing[0];
  if (current?.status === 'revoking')
    throw new Error('This provider grant is being revoked; retry after revocation completes');
  const legacyAccountIds: string[] = [];
  for (const destination of destinations) {
    const owners = await database
      .select({
        accountId: providerAccounts.id,
        connectionId: providerAccounts.connectionId,
        provider: providerConnections.provider,
        grantFamily: providerConnections.grantFamily,
        externalSubjectId: providerConnections.externalSubjectId,
        status: providerConnections.status,
        disconnectedAt: providerAccounts.disconnectedAt,
      })
      .from(providerAccounts)
      .innerJoin(providerConnections, eq(providerAccounts.connectionId, providerConnections.id))
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          input.provider === 'instagram_login'
            ? inArray(providerConnections.provider, ['instagram_login', 'meta'])
            : eq(providerConnections.provider, input.provider),
          eq(providerAccounts.destinationProvider, destination.destinationProvider),
          eq(providerAccounts.remoteAccountId, destination.remoteAccountId),
        ),
      );
    for (const owner of owners) {
      if (owner.connectionId === current?.id) continue;
      if (
        input.provider === 'instagram_login' &&
        owner.provider === 'meta' &&
        owner.status === 'disconnected' &&
        owner.disconnectedAt !== null &&
        destination.destinationProvider === 'instagram' &&
        !owners.some((candidate) => candidate.connectionId === current?.id)
      ) {
        legacyAccountIds.push(owner.accountId);
        continue;
      }
      if (
        input.provider === 'meta' &&
        input.grantFamily &&
        owner.grantFamily === null &&
        owner.externalSubjectId === subjectId &&
        owner.status === 'disconnected' &&
        !owners.some((candidate) => candidate.connectionId === current?.id)
      ) {
        legacyAccountIds.push(owner.accountId);
        continue;
      }
      throw new ProviderDestinationConflictError();
    }
  }
  if (new Set(legacyAccountIds).size !== legacyAccountIds.length || legacyAccountIds.length > 1)
    throw new ProviderDestinationConflictError();
  const connectionRows = current
    ? await database
        .update(providerConnections)
        .set({
          credentialId: input.credentialId,
          externalSubjectId: subjectId,
          status: 'active',
          expiresAt: input.expiresAt ?? null,
          scopes: input.scopes ? [...input.scopes] : [],
          accessExpiresAt: input.accessExpiresAt ?? null,
          refreshExpiresAt: input.refreshExpiresAt ?? null,
          lastRefreshedAt: null,
          revokedAt: null,
          lastErrorCode: null,
          updatedAt: new Date(),
        })
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
          grantFamily: input.grantFamily ?? null,
          memberUrn,
          externalSubjectId: subjectId,
          credentialId: input.credentialId,
          expiresAt: input.expiresAt,
          scopes: input.scopes ? [...input.scopes] : [],
          accessExpiresAt: input.accessExpiresAt,
          refreshExpiresAt: input.refreshExpiresAt,
        })
        .returning({ id: providerConnections.id });
  const connection = connectionRows[0];
  if (!connection) throw new Error('Provider connection write returned no record');
  if (legacyAccountIds.length > 0)
    await database
      .update(providerAccounts)
      .set({ connectionId: connection.id, updatedAt: new Date() })
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          inArray(providerAccounts.id, legacyAccountIds),
        ),
      );
  const existingAccounts = await database
    .select({
      id: providerAccounts.id,
      credentialId: providerAccounts.credentialId,
      availability: providerAccounts.availability,
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
  const replacedAccountCredentialIds = existingAccounts.flatMap((account) =>
    account.credentialId ? [account.credentialId] : [],
  );
  const discoveredKeys = new Set(
    destinations.map((account) =>
      destinationKey(account.destinationProvider, account.remoteAccountId),
    ),
  );
  const now = new Date();
  const lifecycleEvents: {
    action: string;
    targetId: string;
    metadata: Record<string, unknown>;
  }[] = [];
  for (const account of existingAccounts) {
    if (
      !discoveredKeys.has(
        destinationKey(account.destinationProvider as DestinationProvider, account.remoteAccountId),
      )
    )
      await database
        .update(providerAccounts)
        .set({ availability: 'remote_missing', updatedAt: now })
        .where(
          and(
            eq(providerAccounts.workspaceId, input.workspaceId),
            eq(providerAccounts.id, account.id),
          ),
        );
    if (
      !discoveredKeys.has(
        destinationKey(account.destinationProvider as DestinationProvider, account.remoteAccountId),
      )
    )
      lifecycleEvents.push({
        action: 'provider.destination.lost',
        targetId: account.id,
        metadata: { destinationProvider: account.destinationProvider },
      });
  }
  for (const account of destinations) {
    const existingId = existingByDestination.get(
      destinationKey(account.destinationProvider, account.remoteAccountId),
    );
    if (!existingId) continue;
    const previous = existingAccounts.find((account) => account.id === existingId);
    await database
      .update(providerAccounts)
      .set({
        providerAccountId: account.providerAccountId,
        displayName: account.displayName,
        remoteParentAccountId: account.remoteParentAccountId ?? null,
        credentialId: account.credentialId ?? null,
        capabilitySnapshot: account.capabilitySnapshot ?? {},
        capabilitiesCheckedAt: account.capabilitiesCheckedAt ?? null,
        availability: account.availability ?? 'active',
        disconnectedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.id, existingId),
        ),
      );
    if (previous?.availability !== 'active' && (account.availability ?? 'active') === 'active')
      lifecycleEvents.push({
        action: 'provider.destination.reactivated',
        targetId: existingId,
        metadata: { destinationProvider: account.destinationProvider },
      });
    if (previous?.credentialId && previous.credentialId !== (account.credentialId ?? null))
      lifecycleEvents.push({
        action: 'provider.destination.credential_rotated',
        targetId: existingId,
        metadata: { destinationProvider: account.destinationProvider },
      });
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
        availability: account.availability ?? 'active',
        displayName: account.displayName,
      })),
    );
  const insertedAccounts = await database
    .select({ id: providerAccounts.id, destinationProvider: providerAccounts.destinationProvider })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.workspaceId, input.workspaceId),
        eq(providerAccounts.connectionId, connection.id),
      ),
    );
  for (const account of insertedAccounts)
    if (!existingAccounts.some((existingAccount) => existingAccount.id === account.id))
      lifecycleEvents.push({
        action: 'provider.destination.discovered',
        targetId: account.id,
        metadata: { destinationProvider: account.destinationProvider },
      });
  if (input.provider === 'meta' && lifecycleEvents.length > 0)
    await database.insert(auditEvents).values(
      lifecycleEvents.map((event) => ({
        workspaceId: input.workspaceId,
        actorType: 'user' as const,
        actorId: input.userId,
        action: event.action,
        targetType: 'provider_account',
        targetId: event.targetId,
        requestId: input.requestId,
        metadata: event.metadata,
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
  return {
    connectionId: connection.id,
    replacedCredentialId: current?.credentialId ?? null,
    replacedAccountCredentialIds,
  };
}

export async function markProviderDestinationsUnavailable(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    userId: string;
    provider: string;
    connectionId: string;
    availability: 'reauth_required' | 'permission_lost';
    requestId: string;
  },
): Promise<number> {
  const connections = await database
    .select({ id: providerConnections.id })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.workspaceId, input.workspaceId),
        eq(providerConnections.provider, input.provider),
        eq(providerConnections.id, input.connectionId),
      ),
    );
  const connectionId = connections[0]?.id;
  if (!connectionId) return 0;
  const now = new Date();
  const rows = await database
    .update(providerAccounts)
    .set({ availability: input.availability, updatedAt: now })
    .where(
      and(
        eq(providerAccounts.workspaceId, input.workspaceId),
        eq(providerAccounts.connectionId, connectionId),
      ),
    )
    .returning({ id: providerAccounts.id });
  await database.insert(auditEvents).values({
    workspaceId: input.workspaceId,
    actorType: 'user',
    actorId: input.userId,
    action: `provider.destination.${input.availability}`,
    targetType: 'provider_connection',
    targetId: connectionId,
    requestId: input.requestId,
    metadata: { provider: input.provider, destinationCount: rows.length },
  });
  return rows.length;
}
