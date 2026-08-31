import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { apiKeys } from '../../database/schema.js';

export interface StoredApiKey {
  id: string;
  workspaceId: string;
  prefix: string;
  secretHash: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export async function findApiKeyByPrefix(
  database: NodePgDatabase,
  workspaceId: string,
  prefix: string,
): Promise<StoredApiKey | null> {
  const rows = await database
    .select({
      id: apiKeys.id,
      workspaceId: apiKeys.workspaceId,
      prefix: apiKeys.prefix,
      secretHash: apiKeys.secretHash,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.prefix, prefix)))
    .limit(1);
  return rows[0] ?? null;
}

export async function revokeApiKey(
  database: NodePgDatabase,
  workspaceId: string,
  apiKeyId: string,
  revokedAt: Date,
): Promise<boolean> {
  const rows = await database
    .update(apiKeys)
    .set({ revokedAt, updatedAt: revokedAt })
    .where(and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.id, apiKeyId)))
    .returning({ id: apiKeys.id });
  return rows.length === 1;
}
