import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { auditEvents, providerAccounts, providerConnections } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { getActiveCredential } from '../credentials/credential.repository.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import { getFreshInstagramLoginToken } from './instagram-login-credential.service.js';
import {
  hasExactInstagramLoginScopes,
  type InstagramLoginClient,
} from './instagram-login-client.js';

interface PromotionInput {
  workspaceId: string;
  accountId: string;
  requestId: string;
  now?: Date;
}

// Deliberately separate from OAuth callback: a reviewed release must precede promotion.
export async function promoteInstagramLoginAccount(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: InstagramLoginClient,
  input: PromotionInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  const candidate = await withTenantTransaction(database, input, async (transaction) => {
    const rows = await transaction
      .select({
        subject: providerConnections.externalSubjectId,
        provider: providerConnections.provider,
        availability: providerAccounts.availability,
      })
      .from(providerAccounts)
      .innerJoin(providerConnections, eq(providerConnections.id, providerAccounts.connectionId))
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.id, input.accountId),
        ),
      )
      .limit(1);
    return rows[0];
  });
  if (
    candidate?.provider !== 'instagram_login' ||
    candidate.availability !== 'publishing_unavailable'
  )
    return false;
  const token = await getFreshInstagramLoginToken(database, keys, client, {
    workspaceId: input.workspaceId,
    appScopedUserId: candidate.subject,
    requestId: input.requestId,
    now,
  });
  const identity = await client.lookupAccount(token);
  if (identity.appScopedUserId !== candidate.subject) return false;

  return withTenantTransaction(database, input, async (transaction) => {
    const rows = await transaction
      .select({
        connectionId: providerConnections.id,
        provider: providerConnections.provider,
        subject: providerConnections.externalSubjectId,
        scopes: providerConnections.scopes,
        status: providerConnections.status,
        revokedAt: providerConnections.revokedAt,
        expiresAt: providerConnections.accessExpiresAt,
        connectionCredentialId: providerConnections.credentialId,
        accountCredentialId: providerAccounts.credentialId,
        remoteId: providerAccounts.remoteAccountId,
        availability: providerAccounts.availability,
        disconnectedAt: providerAccounts.disconnectedAt,
      })
      .from(providerAccounts)
      .innerJoin(providerConnections, eq(providerConnections.id, providerAccounts.connectionId))
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.id, input.accountId),
        ),
      )
      .for('update')
      .limit(1);
    const row = rows[0];
    if (
      row?.provider !== 'instagram_login' ||
      row.subject !== identity.appScopedUserId ||
      row.remoteId !== identity.remoteUserId ||
      row.status !== 'active' ||
      row.revokedAt ||
      row.disconnectedAt ||
      row.availability !== 'publishing_unavailable' ||
      !row.expiresAt ||
      row.expiresAt <= now ||
      row.accountCredentialId !== row.connectionCredentialId ||
      !hasExactInstagramLoginScopes(row.scopes) ||
      !(await getActiveCredential(transaction, input.workspaceId, row.connectionCredentialId))
    )
      return false;
    await transaction
      .update(providerAccounts)
      .set({ availability: 'active', updatedAt: now })
      .where(
        and(
          eq(providerAccounts.workspaceId, input.workspaceId),
          eq(providerAccounts.id, input.accountId),
          eq(providerAccounts.availability, 'publishing_unavailable'),
          isNull(providerAccounts.disconnectedAt),
        ),
      );
    await transaction.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorType: 'system',
      action: 'instagram.login.publishing_enabled',
      targetType: 'provider_account',
      targetId: input.accountId,
      requestId: input.requestId,
      metadata: { connectionId: row.connectionId },
    });
    return true;
  });
}
