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
import type { SnapchatHttpClient, SnapchatToken } from './snapchat-http-client.js';

const credentialSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  scope: z.string().min(1),
});
const REFRESH_SKEW_MS = 60_000;

async function readOwner(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: { workspaceId: string; profileId: string },
) {
  const record = await withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const rows = await transaction
        .select({
          credentialId: providerConnections.credentialId,
          accessExpiresAt: providerConnections.accessExpiresAt,
        })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.workspaceId, input.workspaceId),
            eq(providerConnections.provider, 'snapchat'),
            eq(providerConnections.externalSubjectId, input.profileId),
            eq(providerConnections.status, 'active'),
            isNull(providerConnections.revokedAt),
          ),
        )
        .limit(1);
      const connection = rows[0];
      if (!connection) return null;
      const credential = await getActiveCredential(
        transaction,
        input.workspaceId,
        connection.credentialId,
      );
      return credential ? { ...connection, credential } : null;
    },
  );
  if (!record) throw new Error('Snapchat profile requires reconnection');
  const plaintext = await decryptCredential(record.credential, keys);
  try {
    return { ...record, token: credentialSchema.parse(JSON.parse(plaintext.toString('utf8'))) };
  } finally {
    plaintext.fill(0);
  }
}

export async function getFreshSnapchatToken(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: SnapchatHttpClient,
  input: { workspaceId: string; profileId: string; requestId: string; now?: Date },
): Promise<SnapchatToken> {
  const current = await readOwner(database, keys, input);
  const now = input.now ?? new Date();
  if (
    current.accessExpiresAt &&
    current.accessExpiresAt.getTime() > now.getTime() + REFRESH_SKEW_MS
  )
    return current.token;

  const refreshed = await client.refreshToken(current.token.refresh_token);
  const profile = await client.discoverOwnerProfile(refreshed.access_token);
  if (profile.id !== input.profileId)
    throw new Error('Snapchat refresh returned a different owner profile');
  const plaintext = Buffer.from(JSON.stringify(refreshed));
  let encrypted;
  try {
    encrypted = await encryptCredential(plaintext, keys);
  } finally {
    plaintext.fill(0);
  }
  const rotated = await rotateProviderSubjectCredential(database, {
    workspaceId: input.workspaceId,
    provider: 'snapchat',
    externalSubjectId: input.profileId,
    expectedVersion: current.credential.version,
    encrypted,
    scopes: refreshed.scope.split(/[\s,]+/).filter(Boolean),
    accessExpiresAt: new Date(now.getTime() + refreshed.expires_in * 1000),
    refreshExpiresAt: null,
    requestId: input.requestId,
  });
  if (rotated) return refreshed;
  const winner = await readOwner(database, keys, input);
  if (!winner.accessExpiresAt || winner.accessExpiresAt <= now)
    throw new Error('Concurrent Snapchat refresh did not produce a usable token');
  return winner.token;
}
