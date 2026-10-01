import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  auditEvents,
  providerAccounts,
  providerConnections,
  publicationJobs,
} from '../../database/schema.js';
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
    accessExpiresAt: Date;
    refreshExpiresAt: Date | null;
  },
): Promise<boolean> {
  return withTenantTransaction(database, input, async (transaction) => {
    const rows = await transaction
      .select({ id: providerConnections.id, credentialId: providerConnections.credentialId })
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
        scopes: [...input.scopes],
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
    const activeJobs = await transaction
      .select({ id: publicationJobs.id })
      .from(publicationJobs)
      .innerJoin(providerAccounts, eq(publicationJobs.providerAccountId, providerAccounts.id))
      .where(
        and(
          eq(publicationJobs.workspaceId, input.workspaceId),
          eq(providerAccounts.connectionId, connection.id),
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
    if (activeJobs[0]) throw new Error('Scheduled publications must be resolved before disconnect');
    const accounts = await transaction
      .select({ credentialId: providerAccounts.credentialId })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.connectionId, connection.id),
        ),
      );
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
