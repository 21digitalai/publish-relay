import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { registeredClients } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type {
  DelegatedAuthorizationStore,
  DelegatedPrincipal,
} from './delegated-authorization.service.js';

interface CredentialRow extends DelegatedPrincipal, Record<string, unknown> {
  redirectUri: string;
  codeChallenge: string;
  tokenId: string;
}

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
          await transaction.execute(sql`
            INSERT INTO delegated_grants (id, workspace_id, user_id, client_id, scopes)
            VALUES (${input.grantId}, ${input.workspaceId}, ${input.userId},
              ${input.clientId}, ${input.scopes})
          `);
          await transaction.execute(sql`
            INSERT INTO delegated_authorization_codes (
              workspace_id, grant_id, client_id, code_hash, redirect_uri,
              scopes, code_challenge, expires_at
            ) VALUES (
              ${input.workspaceId}, ${input.grantId}, ${input.clientId}, ${input.codeHash},
              ${input.redirectUri}, ${input.scopes}, ${input.codeChallenge}, ${input.expiresAt}
            )
          `);
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
      const result = await database.execute<CredentialRow>(sql`
        SELECT grant_id AS "grantId", workspace_id AS "workspaceId", user_id AS "userId",
          client_id AS "clientId", scopes
        FROM resolve_delegated_access_token(${accessTokenHash}, ${now})
      `);
      return rows(result)[0] ?? null;
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

    async revokeGrant(workspaceId, userId, grantId, now) {
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
        return true;
      });
    },
  };
}
