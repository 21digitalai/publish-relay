import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  auditEvents,
  providerAccounts,
  providerConnections,
  workspaces,
} from '../../database/schema.js';
import { hasActiveProviderAccountJobs } from './provider-account-exposure.service.js';
import { revokeCredential, rotateCredential } from './credential.repository.js';
import type { EncryptedCredential } from './envelope.js';
import { assertActiveMembership } from './provider-connection.repository.js';

interface ProviderSubject {
  workspaceId: string;
  provider: string;
  externalSubjectId: string;
  requestId: string;
}

export async function rotateProviderSubjectCredential(
  database: NodePgDatabase,
  input: ProviderSubject & {
    expectedVersion: number;
    encrypted: EncryptedCredential;
    scopes: readonly string[];
    preserveStoredScopes?: boolean;
    accessExpiresAt: Date;
    refreshExpiresAt: Date | null;
  },
): Promise<boolean> {
  return withTenantTransaction(database, input, async (transaction) => {
    const rows = await transaction
      .select({
        id: providerConnections.id,
        credentialId: providerConnections.credentialId,
        scopes: providerConnections.scopes,
      })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.workspaceId, input.workspaceId),
          eq(providerConnections.provider, input.provider),
          eq(providerConnections.externalSubjectId, input.externalSubjectId),
          eq(providerConnections.status, 'active'),
          isNull(providerConnections.revokedAt),
        ),
      )
      .for('update')
      .limit(1);
    const connection = rows[0];
    if (!connection) return false;
    if (
      input.preserveStoredScopes &&
      JSON.stringify(connection.scopes) !== JSON.stringify(input.scopes)
    )
      return false;
    const rotated = await rotateCredential(
      transaction,
      input.workspaceId,
      connection.credentialId,
      input.expectedVersion,
      input.encrypted,
    );
    if (!rotated) return false;
    const now = new Date();
    await transaction
      .update(providerConnections)
      .set({
        scopes: input.preserveStoredScopes ? connection.scopes : [...input.scopes],
        accessExpiresAt: input.accessExpiresAt,
        refreshExpiresAt: input.refreshExpiresAt,
        lastRefreshedAt: now,
        lastErrorCode: null,
        updatedAt: now,
      })
      .where(eq(providerConnections.id, connection.id));
    await transaction.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorType: 'system',
      action: 'provider.credential_refreshed',
      targetType: 'provider_connection',
      targetId: connection.id,
      requestId: input.requestId,
      metadata: { provider: input.provider },
    });
    return true;
  });
}

export async function disconnectProviderSubject(
  database: NodePgDatabase,
  input: ProviderSubject & { userId: string },
): Promise<boolean> {
  return withTenantTransaction(database, input, async (transaction) => {
    await assertActiveMembership(transaction, input.workspaceId, input.userId);
    await transaction
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .for('update');
    const rows = await transaction
      .select({ id: providerConnections.id, credentialId: providerConnections.credentialId })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.workspaceId, input.workspaceId),
          eq(providerConnections.provider, input.provider),
          eq(providerConnections.externalSubjectId, input.externalSubjectId),
        ),
      )
      .for('update')
      .limit(1);
    const connection = rows[0];
    if (!connection) return false;
    const accounts = await transaction
      .select({ id: providerAccounts.id, credentialId: providerAccounts.credentialId })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.connectionId, connection.id),
        ),
      );
    for (const account of accounts)
      if (await hasActiveProviderAccountJobs(transaction, input.workspaceId, account.id))
        throw new Error('Scheduled publications must be resolved before disconnect');
    const now = new Date();
    await transaction
      .update(providerAccounts)
      .set({
        availability: 'reauth_required',
        disconnectedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.connectionId, connection.id),
        ),
      );
    await transaction
      .update(providerConnections)
      .set({
        status: 'revoked',
        revokedAt: now,
        updatedAt: now,
      })
      .where(eq(providerConnections.id, connection.id));
    await revokeCredential(transaction, input.workspaceId, connection.credentialId, now);
    for (const credentialId of new Set(
      accounts.flatMap((account) => (account.credentialId ? [account.credentialId] : [])),
    ))
      await revokeCredential(transaction, input.workspaceId, credentialId, now);
    await transaction.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorType: 'user',
      actorId: input.userId,
      action: 'provider.subject_disconnected',
      targetType: 'provider_connection',
      targetId: connection.id,
      requestId: input.requestId,
      metadata: { provider: input.provider },
    });
    return true;
  });
}
