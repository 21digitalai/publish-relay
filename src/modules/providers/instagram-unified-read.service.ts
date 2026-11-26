import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerAccounts, providerConnections } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { getActiveCredential } from '../credentials/credential.repository.js';
import { decryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
import { InstagramUnifiedReadError } from './instagram-unified-read-client.js';
import type { InstagramUnifiedReadClient } from './instagram-unified-read-client.js';

export class InstagramUnifiedReadUnavailableError extends Error {}

async function loadToken(runtime: { database: NodePgDatabase; keys: MasterKeyProvider }, input: { workspaceId: string; accountId: string }) {
  const row = await withTenantTransaction(runtime.database, { workspaceId: input.workspaceId }, async (tx) => {
    const rows = await tx.select({ accountCredentialId: providerAccounts.credentialId, connectionCredentialId: providerConnections.credentialId, remoteAccountId: providerAccounts.remoteAccountId })
      .from(providerAccounts).innerJoin(providerConnections, eq(providerConnections.id, providerAccounts.connectionId))
      .where(and(eq(providerAccounts.workspaceId, input.workspaceId), eq(providerAccounts.id, input.accountId), eq(providerAccounts.destinationProvider, 'instagram'), eq(providerConnections.provider, 'instagram_unified_login'), eq(providerConnections.status, 'active'), isNull(providerAccounts.disconnectedAt), isNull(providerConnections.revokedAt))).limit(1);
    return rows[0] ?? null;
  });
  const credentialId = row?.accountCredentialId ?? row?.connectionCredentialId;
  if (!row || !credentialId) throw new InstagramUnifiedReadUnavailableError('Unified Instagram read is unavailable');
  const stored = await withTenantTransaction(runtime.database, { workspaceId: input.workspaceId }, (tx) => getActiveCredential(tx, input.workspaceId, credentialId));
  if (!stored) throw new InstagramUnifiedReadUnavailableError('Unified Instagram read is unavailable');
  const plaintext = await decryptCredential(stored, runtime.keys);
  try {
    const parsed = JSON.parse(plaintext.toString('utf8')) as { accessToken?: unknown };
    if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0) throw new InstagramUnifiedReadUnavailableError('Unified Instagram read is unavailable');
    return { accessToken: parsed.accessToken, remoteAccountId: row.remoteAccountId };
  } finally { plaintext.fill(0); }
}

export function createInstagramUnifiedReadService(runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: InstagramUnifiedReadClient }) {
  return {
    async permissions(input: { workspaceId: string; accountId: string }) {
      const token = await loadToken(runtime, input);
      return runtime.client.verifyPermissions(token.accessToken);
    },
    async media(input: { workspaceId: string; accountId: string; limit?: number; after?: string }) {
      const token = await loadToken(runtime, input);
      return runtime.client.listMedia({ accountId: token.remoteAccountId, accessToken: token.accessToken, ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.after === undefined ? {} : { after: input.after }) });
    },
    async comments(input: { workspaceId: string; accountId: string; mediaId: string; limit?: number; after?: string }) {
      const token = await loadToken(runtime, input);
      return runtime.client.listComments({ accountId: token.remoteAccountId, mediaId: input.mediaId, accessToken: token.accessToken, ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.after === undefined ? {} : { after: input.after }) });
    },
  };
}

export function instagramUnifiedReadStatus(error: unknown): { status: number; error: string } {
  if (error instanceof InstagramUnifiedReadUnavailableError) return { status: 404, error: 'Unified Instagram read is unavailable' };
  if (error instanceof InstagramUnifiedReadError) return { status: error.kind === 'rate_limit' ? 429 : error.kind === 'permission' || error.kind === 'auth' ? 409 : 502, error: 'Unified Instagram read failed' };
  throw error;
}
