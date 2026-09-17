import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  auditEvents,
  delegatedAuthorizationCodes,
  delegatedGrants,
  registeredClients,
} from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type {
  DelegatedAuthorizationStore,
  DelegatedAccessPrincipal,
  DelegatedPrincipal,
} from './delegated-authorization.service.js';

interface CredentialRow extends DelegatedPrincipal, Record<string, unknown> {
  redirectUri: string;
  codeChallenge: string;
  tokenId: string;
}

interface AccessCredentialRow extends DelegatedAccessPrincipal, Record<string, unknown> {}

interface GrantRow extends Record<string, unknown> {
  id: string;
  clientId: string;
  scopes: string[];
  createdAt: Date;
}

function rows<T>(result: { rows?: T[] } | T[]): T[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

export function createPostgresDelegatedAuthorizationStore(
  database: NodePgDatabase,
): DelegatedAuthorizationStore {
  return {
    async findClient(clientId) {
      const found = await database
        .select({
          id: registeredClients.id,
          clientType: registeredClients.clientType,
          secretHash: registeredClients.secretHash,
          redirectUris: registeredClients.redirectUris,
          allowedScopes: registeredClients.allowedScopes,
        })
        .from(registeredClients)
        .where(eq(registeredClients.id, clientId))
        .limit(1);
      return found[0] ?? null;
    },

    async createGrantAndCode(input) {
      await withTenantTransaction(
        database,
        { workspaceId: input.workspaceId, userId: input.userId },
        async (transaction) => {
          await transaction.insert(delegatedGrants).values({
            id: input.grantId,
            workspaceId: input.workspaceId,
            userId: input.userId,
            clientId: input.clientId,
            scopes: input.scopes,
          });
          await transaction.insert(auditEvents).values({
            workspaceId: input.workspaceId,
            actorType: 'user',
            actorId: input.userId,
            action: 'delegated_grant.approved',
            targetType: 'delegated_grant',
            targetId: input.grantId,
            requestId: input.requestId,
            metadata: { clientId: input.clientId, scopes: input.scopes },
          });
          await transaction.insert(delegatedAuthorizationCodes).values({
            workspaceId: input.workspaceId,
            grantId: input.grantId,
            clientId: input.clientId,
            codeHash: input.codeHash,
            redirectUri: input.redirectUri,
            scopes: input.scopes,
            codeChallenge: input.codeChallenge,
            expiresAt: input.expiresAt,
          });
        },
      );
    },

    async exchangeCode(input) {
      const result = await database.execute<CredentialRow>(sql`
        SELECT grant_id AS "grantId", workspace_id AS "workspaceId", user_id AS "userId",
          client_id AS "clientId", scopes
        FROM exchange_delegated_authorization_code(
          ${input.codeHash}, ${input.clientId}, ${input.redirectUri}, ${input.codeChallenge},
          ${input.replacement.accessTokenHash}, ${input.replacement.refreshTokenHash},
          ${input.replacement.accessExpiresAt}, ${input.replacement.refreshExpiresAt}, ${input.now}
        )
      `);
      return rows(result)[0] ?? null;
    },

    async rotateRefreshToken(input) {
      const result = await database.execute<CredentialRow>(sql`
        SELECT grant_id AS "grantId", workspace_id AS "workspaceId", user_id AS "userId",
          client_id AS "clientId", scopes
        FROM rotate_delegated_refresh_token(
          ${input.refreshTokenHash}, ${input.replacement.accessTokenHash},
          ${input.replacement.refreshTokenHash}, ${input.replacement.accessExpiresAt},
          ${input.replacement.refreshExpiresAt}, ${input.now}
        )
      `);
      return rows(result)[0] ?? null;
    },

    async authenticateAccessToken(accessTokenHash, now) {
      const result = await database.execute<AccessCredentialRow>(sql`
        SELECT grant_id AS "grantId", workspace_id AS "workspaceId", user_id AS "userId",
          workspace_label AS "workspaceLabel", client_id AS "clientId", scopes,
          access_expires_at AS "accessExpiresAt"
        FROM resolve_delegated_access_token(${accessTokenHash}, ${now})
      `);
      return rows(result)[0] ?? null;
    },

    async revokeByToken(input) {
      await database.execute(sql`
        SELECT revoke_delegated_token_family(
          ${input.tokenHash}, ${input.clientId}, ${input.now}, ${input.requestId}
        )
      `);
    },

    async listGrants(workspaceId, userId) {
      return withTenantTransaction(database, { workspaceId, userId }, async (transaction) => {
        const result = await transaction.execute<GrantRow>(sql`
          SELECT id, client_id AS "clientId", scopes, created_at AS "createdAt"
          FROM delegated_grants
          WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND revoked_at IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT 100
        `);
        return rows(result);
      });
    },

    async revokeGrant(workspaceId, userId, grantId, now, requestId) {
      return withTenantTransaction(database, { workspaceId, userId }, async (transaction) => {
        const result = await transaction.execute<{ id: string }>(sql`
          UPDATE delegated_grants SET revoked_at = ${now}, updated_at = ${now}
          WHERE workspace_id = ${workspaceId} AND id = ${grantId}
            AND user_id = ${userId} AND revoked_at IS NULL
          RETURNING id
        `);
        if (!rows(result)[0]) return false;
        await transaction.execute(sql`
          UPDATE delegated_tokens SET revoked_at = ${now}, updated_at = ${now}
          WHERE workspace_id = ${workspaceId} AND grant_id = ${grantId} AND revoked_at IS NULL
        `);
        await transaction.insert(auditEvents).values({
          workspaceId,
          actorType: 'user',
          actorId: userId,
          action: 'delegated_grant.revoked',
          targetType: 'delegated_grant',
          targetId: grantId,
          requestId,
          metadata: {},
        });
        return true;
      });
    },
  };
}
