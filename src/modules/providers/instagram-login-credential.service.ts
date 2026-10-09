import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { providerConnections } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { getActiveCredential } from '../credentials/credential.repository.js';
import {
  decryptCredential,
  encryptCredential,
  type MasterKeyProvider,
} from '../credentials/envelope.js';
import { rotateProviderSubjectCredential } from '../credentials/provider-subject.service.js';
import { INSTAGRAM_LOGIN_SCOPES, type InstagramLoginClient } from './instagram-login-client.js';

const credentialSchema = z.object({ accessToken: z.string().min(1) });
const REFRESH_SKEW_MS = 24 * 60 * 60 * 1000;
const MIN_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;

async function readGrant(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  workspaceId: string,
  appScopedUserId: string,
) {
  const record = await withTenantTransaction(database, { workspaceId }, async (transaction) => {
    const rows = await transaction
      .select({
        credentialId: providerConnections.credentialId,
        accessExpiresAt: providerConnections.accessExpiresAt,
        lastRefreshedAt: providerConnections.lastRefreshedAt,
      })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.workspaceId, workspaceId),
          eq(providerConnections.provider, 'instagram_login'),
          eq(providerConnections.externalSubjectId, appScopedUserId),
          eq(providerConnections.status, 'active'),
          isNull(providerConnections.revokedAt),
        ),
      )
      .limit(1);
    const connection = rows[0];
    if (!connection) return null;
    const credential = await getActiveCredential(transaction, workspaceId, connection.credentialId);
    return credential ? { ...connection, credential } : null;
  });
  if (!record) throw new Error('Instagram account requires reconnection');
  const plaintext = await decryptCredential(record.credential, keys);
  try {
    return { ...record, token: credentialSchema.parse(JSON.parse(plaintext.toString('utf8'))) };
  } finally {
    plaintext.fill(0);
  }
}

export async function getFreshInstagramLoginToken(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: InstagramLoginClient,
  input: { workspaceId: string; appScopedUserId: string; requestId: string; now?: Date },
): Promise<string> {
  const now = input.now ?? new Date();
  const current = await readGrant(database, keys, input.workspaceId, input.appScopedUserId);
  if (!current.accessExpiresAt || current.accessExpiresAt <= now)
    throw new Error('Instagram grant expired; reconnect this account');
  if (current.accessExpiresAt.getTime() > now.getTime() + REFRESH_SKEW_MS)
    return current.token.accessToken;
  if (
    current.lastRefreshedAt &&
    now.getTime() - current.lastRefreshedAt.getTime() < MIN_REFRESH_AGE_MS
  )
    throw new Error('Instagram token cannot be refreshed yet; retry later');
  const refreshed = await client.refreshToken(current.token.accessToken);
  const plaintext = Buffer.from(JSON.stringify({ accessToken: refreshed.accessToken }));
  let encrypted;
  try {
    encrypted = await encryptCredential(plaintext, keys);
  } finally {
    plaintext.fill(0);
  }
  const rotated = await rotateProviderSubjectCredential(database, {
    workspaceId: input.workspaceId,
    provider: 'instagram_login',
    externalSubjectId: input.appScopedUserId,
    expectedVersion: current.credential.version,
    encrypted,
    scopes: INSTAGRAM_LOGIN_SCOPES,
    accessExpiresAt: refreshed.expiresAt,
    refreshExpiresAt: null,
    requestId: input.requestId,
  });
  if (rotated) return refreshed.accessToken;
  const winner = await readGrant(database, keys, input.workspaceId, input.appScopedUserId);
  if (!winner.accessExpiresAt || winner.accessExpiresAt <= now)
    throw new Error('Concurrent Instagram token refresh did not produce a usable credential');
  return winner.token.accessToken;
}
