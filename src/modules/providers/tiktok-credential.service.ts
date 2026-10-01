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
import type { TikTokHttpClient, TikTokToken } from './tiktok-http-client.js';

const credentialSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  open_id: z.string().min(1),
  scope: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  refresh_expires_in: z.number().int().positive(),
});
const REFRESH_SKEW_MS = 60_000;

async function readSubject(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: { workspaceId: string; openId: string },
) {
  const record = await withTenantTransaction(
    database,
    { workspaceId: input.workspaceId },
    async (transaction) => {
      const rows = await transaction
        .select({
          credentialId: providerConnections.credentialId,
          accessExpiresAt: providerConnections.accessExpiresAt,
          refreshExpiresAt: providerConnections.refreshExpiresAt,
        })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.workspaceId, input.workspaceId),
            eq(providerConnections.provider, 'tiktok'),
            eq(providerConnections.externalSubjectId, input.openId),
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
  if (!record) throw new Error('TikTok account requires reconnection');
  const plaintext = await decryptCredential(record.credential, keys);
  try {
    const token = credentialSchema.parse(JSON.parse(plaintext.toString('utf8')));
    if (token.open_id !== input.openId) throw new Error('TikTok credential subject mismatch');
    return { ...record, token };
  } finally {
    plaintext.fill(0);
  }
}

export async function getFreshTikTokToken(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  client: TikTokHttpClient,
  input: { workspaceId: string; openId: string; requestId: string; now?: Date },
): Promise<TikTokToken> {
  const current = await readSubject(database, keys, input);
  const now = input.now ?? new Date();
  if (current.refreshExpiresAt && current.refreshExpiresAt <= now)
    throw new Error('TikTok refresh grant expired; reconnect this account');
  if (
    current.accessExpiresAt &&
    current.accessExpiresAt.getTime() > now.getTime() + REFRESH_SKEW_MS
  )
    return current.token;

  const refreshed = await client.refresh(current.token.refresh_token);
  if (refreshed.open_id !== input.openId)
    throw new Error('TikTok refresh returned a different account subject');
  const plaintext = Buffer.from(JSON.stringify(refreshed));
  let encrypted;
  try {
    encrypted = await encryptCredential(plaintext, keys);
  } finally {
    plaintext.fill(0);
  }
  const rotated = await rotateProviderSubjectCredential(database, {
    workspaceId: input.workspaceId,
    provider: 'tiktok',
    externalSubjectId: input.openId,
    expectedVersion: current.credential.version,
    encrypted,
    scopes: refreshed.scope
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean),
    accessExpiresAt: new Date(now.getTime() + refreshed.expires_in * 1000),
    refreshExpiresAt: new Date(now.getTime() + refreshed.refresh_expires_in * 1000),
    requestId: input.requestId,
  });
  if (rotated) return refreshed;
  const winner = await readSubject(database, keys, input);
  if (!winner.accessExpiresAt || winner.accessExpiresAt <= now)
    throw new Error('Concurrent TikTok refresh did not produce a usable token');
  return winner.token;
}
