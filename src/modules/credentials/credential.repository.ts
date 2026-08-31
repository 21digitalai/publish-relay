import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { credentials, oauthTransactions } from '../../database/schema.js';
import type { EncryptedCredential } from './envelope.js';

export interface StoredCredential extends EncryptedCredential {
  id: string;
  version: number;
  revokedAt: Date | null;
}

const credentialProjection = {
  id: credentials.id,
  keyVersion: credentials.keyVersion,
  wrappedKey: credentials.wrappedKey,
  wrappedKeyNonce: credentials.wrappedKeyNonce,
  wrappedKeyTag: credentials.wrappedKeyTag,
  ciphertext: credentials.ciphertext,
  nonce: credentials.nonce,
  tag: credentials.tag,
  version: credentials.version,
  revokedAt: credentials.revokedAt,
};

export async function createCredential(
  database: NodePgDatabase,
  workspaceId: string,
  encrypted: EncryptedCredential,
): Promise<StoredCredential> {
  const rows = await database
    .insert(credentials)
    .values({ workspaceId, ...encrypted })
    .returning(credentialProjection);
  if (!rows[0]) throw new Error('Credential insert returned no record');
  return rows[0];
}

export async function rotateCredential(
  database: NodePgDatabase,
  workspaceId: string,
  id: string,
  expectedVersion: number,
  encrypted: EncryptedCredential,
): Promise<StoredCredential | null> {
  const rows = await database
    .update(credentials)
    .set({ ...encrypted, version: sql`${credentials.version} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(credentials.workspaceId, workspaceId),
        eq(credentials.id, id),
        eq(credentials.version, expectedVersion),
        isNull(credentials.revokedAt),
      ),
    )
    .returning(credentialProjection);
  return rows[0] ?? null;
}

export async function revokeCredential(
  database: NodePgDatabase,
  workspaceId: string,
  id: string,
  at: Date,
): Promise<boolean> {
  const rows = await database
    .update(credentials)
    .set({ revokedAt: at, updatedAt: at })
    .where(
      and(
        eq(credentials.workspaceId, workspaceId),
        eq(credentials.id, id),
        isNull(credentials.revokedAt),
      ),
    )
    .returning({ id: credentials.id });
  return rows.length === 1;
}

export async function consumeOauthTransaction(
  database: NodePgDatabase,
  workspaceId: string,
  stateHash: string,
  now: Date,
): Promise<{ id: string; userId: string; provider: string } | null> {
  const rows = await database
    .update(oauthTransactions)
    .set({ consumedAt: now, updatedAt: now })
    .where(
      and(
        eq(oauthTransactions.workspaceId, workspaceId),
        eq(oauthTransactions.stateHash, stateHash),
        isNull(oauthTransactions.consumedAt),
        sql`${oauthTransactions.expiresAt} > ${now}`,
      ),
    )
    .returning({
      id: oauthTransactions.id,
      userId: oauthTransactions.userId,
      provider: oauthTransactions.provider,
    });
  return rows[0] ?? null;
}
