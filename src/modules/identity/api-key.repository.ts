import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { apiKeys, auditEvents, workspaces } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { ApiKeyStore } from './api-key.service.js';

export function createPostgresApiKeyStore(database: NodePgDatabase): ApiKeyStore {
  return {
    async create(input) {
      return withTenantTransaction(
        database,
        { workspaceId: input.workspaceId, userId: input.createdByUserId },
        async (transaction) => {
          const rows = await transaction
            .insert(apiKeys)
            .values({
              workspaceId: input.workspaceId,
              createdByUserId: input.createdByUserId,
              label: input.label,
              prefix: input.prefix,
              secretHash: input.secretHash,
              capabilities: input.capabilities,
              expiresAt: input.expiresAt,
            })
            .returning({
              id: apiKeys.id,
              workspaceId: apiKeys.workspaceId,
              prefix: apiKeys.prefix,
              capabilities: apiKeys.capabilities,
              expiresAt: apiKeys.expiresAt,
            });
          const key = rows[0];
          if (!key) throw new Error('API key creation returned no record');
          const workspaceRows = await transaction
            .select({ label: workspaces.name })
            .from(workspaces)
            .where(eq(workspaces.id, input.workspaceId))
            .limit(1);
          const workspace = workspaceRows[0];
          if (!workspace) throw new Error('API key workspace was not found');
          await transaction.insert(auditEvents).values({
            workspaceId: input.workspaceId,
            actorType: 'user',
            actorId: input.createdByUserId,
            action: 'api_key.created',
            targetType: 'api_key',
            targetId: key.id,
            requestId: input.requestId,
            metadata: { prefix: key.prefix, capabilities: key.capabilities },
          });
          return { ...key, workspaceLabel: workspace.label, capabilities: input.capabilities };
        },
      );
    },
    async findByPrefix(workspaceId, prefix) {
      return withTenantTransaction(database, { workspaceId }, async (transaction) => {
        const rows = await transaction
          .select({
            id: apiKeys.id,
            workspaceId: apiKeys.workspaceId,
            workspaceLabel: workspaces.name,
            prefix: apiKeys.prefix,
            secretHash: apiKeys.secretHash,
            capabilities: apiKeys.capabilities,
            expiresAt: apiKeys.expiresAt,
            revokedAt: apiKeys.revokedAt,
          })
          .from(apiKeys)
          .innerJoin(workspaces, eq(workspaces.id, apiKeys.workspaceId))
          .where(and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.prefix, prefix)))
          .limit(1);
        const row = rows[0];
        return row ? { ...row, capabilities: row.capabilities as never } : null;
      });
    },
    async markUsed(workspaceId, keyId, usedAt) {
      await withTenantTransaction(database, { workspaceId }, async (transaction) => {
        await transaction
          .update(apiKeys)
          .set({ lastUsedAt: usedAt, updatedAt: usedAt })
          .where(and(eq(apiKeys.workspaceId, workspaceId), eq(apiKeys.id, keyId)));
      });
    },
    async recordCapabilityDenied(principal, capability, requestId) {
      await withTenantTransaction(database, { workspaceId: principal.workspaceId }, (transaction) =>
        transaction.insert(auditEvents).values({
          workspaceId: principal.workspaceId,
          actorType: 'api_key',
          actorId: principal.id,
          action: 'api_key.capability_denied',
          targetType: 'api_key',
          targetId: principal.id,
          requestId,
          metadata: { requiredCapability: capability },
        }),
      );
    },
    async revoke(input) {
      return withTenantTransaction(
        database,
        { workspaceId: input.workspaceId, userId: input.revokedByUserId },
        async (transaction) => {
          const rows = await transaction
            .update(apiKeys)
            .set({ revokedAt: input.revokedAt, updatedAt: input.revokedAt })
            .where(
              and(
                eq(apiKeys.workspaceId, input.workspaceId),
                eq(apiKeys.id, input.keyId),
                isNull(apiKeys.revokedAt),
              ),
            )
            .returning({ id: apiKeys.id });
          if (!rows[0]) return false;
          await transaction.insert(auditEvents).values({
            workspaceId: input.workspaceId,
            actorType: 'user',
            actorId: input.revokedByUserId,
            action: 'api_key.revoked',
            targetType: 'api_key',
            targetId: input.keyId,
            requestId: input.requestId,
            metadata: {},
          });
          return true;
        },
      );
    },
  };
}

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
