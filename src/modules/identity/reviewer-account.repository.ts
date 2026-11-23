import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { ReviewerAccountStore } from './reviewer-account.service.js';

async function requireOperatorOwner(
  transaction: NodePgDatabase,
  workspaceId: string,
  operatorUserId: string,
): Promise<void> {
  const owner = await transaction.execute(sql`
    SELECT 1
    FROM memberships
    WHERE workspace_id = ${workspaceId}
      AND user_id = ${operatorUserId}
      AND role = 'owner'
  `);
  if (owner.rows.length !== 1) throw new Error('Operator owner membership is required');
}

export function createPostgresReviewerAccountStore(
  database: NodePgDatabase,
): ReviewerAccountStore {
  return {
    async provision(input) {
      return database.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('app.workspace_id', ${input.workspaceId}, true)`);
        await requireOperatorOwner(transaction, input.workspaceId, input.operatorUserId);
        const created = await transaction.execute<{ id: string }>(sql`
          INSERT INTO users (
            display_name, email, password_hash, default_workspace_id, review_access_expires_at
          ) VALUES (
            ${input.displayName}, ${input.email}, ${input.passwordHash},
            ${input.workspaceId}, ${input.expiresAt}
          )
          RETURNING id
        `);
        const userId = created.rows[0]?.id;
        if (!userId) throw new Error('Reviewer account was not created');
        await transaction.execute(sql`
          INSERT INTO memberships (workspace_id, user_id, role)
          VALUES (${input.workspaceId}, ${userId}, 'editor')
        `);
        await transaction.execute(sql`
          INSERT INTO audit_events (
            workspace_id, actor_type, actor_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            ${input.workspaceId}, 'user', ${input.operatorUserId},
            'auth.reviewer.provisioned', 'user', ${userId}, ${input.requestId},
            ${JSON.stringify({ expiresAt: input.expiresAt.toISOString(), role: 'editor' })}::jsonb
          )
        `);
        return { userId };
      });
    },

    async revoke(input) {
      return database.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('app.workspace_id', ${input.workspaceId}, true)`);
        await requireOperatorOwner(transaction, input.workspaceId, input.operatorUserId);
        const reviewer = await transaction.execute<{ id: string }>(sql`
          SELECT users.id
          FROM users
          JOIN memberships
            ON memberships.workspace_id = ${input.workspaceId}
           AND memberships.user_id = users.id
           AND memberships.role = 'editor'
          WHERE lower(users.email) = ${input.email}
            AND users.default_workspace_id = ${input.workspaceId}
            AND users.review_access_expires_at IS NOT NULL
          FOR UPDATE OF users
        `);
        const userId = reviewer.rows[0]?.id;
        if (!userId || reviewer.rows.length !== 1) throw new Error('Reviewer account not found');
        await transaction.execute(sql`
          UPDATE users
          SET is_disabled = true, password_hash = NULL, review_access_expires_at = NULL,
              updated_at = now()
          WHERE id = ${userId}
        `);
        await transaction.execute(sql`
          UPDATE sessions SET revoked_at = now(), updated_at = now()
          WHERE workspace_id = ${input.workspaceId} AND user_id = ${userId} AND revoked_at IS NULL
        `);
        await transaction.execute(sql`
          UPDATE api_keys SET revoked_at = now(), updated_at = now()
          WHERE workspace_id = ${input.workspaceId}
            AND created_by_user_id = ${userId}
            AND revoked_at IS NULL
        `);
        await transaction.execute(sql`
          UPDATE delegated_authorization_codes SET consumed_at = now(), updated_at = now()
          WHERE workspace_id = ${input.workspaceId}
            AND grant_id IN (
              SELECT id FROM delegated_grants
              WHERE workspace_id = ${input.workspaceId} AND user_id = ${userId}
            )
            AND consumed_at IS NULL
        `);
        await transaction.execute(sql`
          UPDATE delegated_tokens SET revoked_at = now(), updated_at = now()
          WHERE workspace_id = ${input.workspaceId}
            AND grant_id IN (
              SELECT id FROM delegated_grants
              WHERE workspace_id = ${input.workspaceId} AND user_id = ${userId}
            )
            AND revoked_at IS NULL
        `);
        await transaction.execute(sql`
          UPDATE delegated_grants SET revoked_at = now(), updated_at = now()
          WHERE workspace_id = ${input.workspaceId} AND user_id = ${userId} AND revoked_at IS NULL
        `);
        await transaction.execute(sql`
          INSERT INTO audit_events (
            workspace_id, actor_type, actor_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            ${input.workspaceId}, 'user', ${input.operatorUserId},
            'auth.reviewer.revoked', 'user', ${userId}, ${input.requestId},
            ${JSON.stringify({ credentialsRevoked: true })}::jsonb
          )
        `);
        return { userId };
      });
    },
  };
}
