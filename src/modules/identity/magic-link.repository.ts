import { and, eq, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  auditEvents,
  authRateLimitBuckets,
  loginChallenges,
  memberships,
  sessions,
  users,
  workspaces,
} from '../../database/schema.js';
import type { MagicLinkStore } from './magic-link.service.js';

const EMAIL_REQUESTS_PER_MINUTE = 5;
const NETWORK_REQUESTS_PER_MINUTE = 20;

function createWorkspaceSlug(name: string): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'workspace';
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

export interface PostgresMagicLinkStore extends MagicLinkStore {
  cleanupExpired: () => Promise<number>;
}

async function incrementRateBucket(
  database: NodePgDatabase,
  kind: 'email' | 'network',
  keyHash: string,
): Promise<number> {
  const result = await database.execute<{ request_count: number }>(sql`
    INSERT INTO auth_rate_limit_buckets (
      kind, key_hash, window_started_at, expires_at
    ) VALUES (${kind}, ${keyHash}, date_trunc('minute', now()), date_trunc('minute', now()) + interval '2 minutes')
    ON CONFLICT (kind, key_hash, window_started_at)
    DO UPDATE SET request_count = auth_rate_limit_buckets.request_count + 1
    RETURNING request_count
  `);
  const count = result.rows[0]?.request_count;
  if (!count) throw new Error('Auth rate-limit bucket was not updated');
  return count;
}

export function createPostgresMagicLinkStore(database: NodePgDatabase): PostgresMagicLinkStore {
  return {
    async findEnabledUserIdByEmail(email) {
      const [user] = await database
        .select({ id: users.id })
        .from(users)
        .where(and(sql`lower(${users.email}) = ${email}`, eq(users.isDisabled, false)))
        .limit(1);
      return user?.id ?? null;
    },

    async consumeRateLimit(input) {
      return database.transaction(async (transaction) => {
        const emailCount = await incrementRateBucket(transaction, 'email', input.emailKeyHash);
        const networkCount = await incrementRateBucket(
          transaction,
          'network',
          input.networkKeyHash,
        );
        return (
          emailCount <= EMAIL_REQUESTS_PER_MINUTE && networkCount <= NETWORK_REQUESTS_PER_MINUTE
        );
      });
    },

    async createChallenge(input) {
      const [challenge] = await database
        .insert(loginChallenges)
        .values(input)
        .returning({ id: loginChallenges.id });
      if (!challenge) throw new Error('Magic-link challenge was not created');
      return challenge.id;
    },

    async markDelivery(challengeId, state, providerMessageId) {
      await database
        .update(loginChallenges)
        .set({ deliveryState: state, providerMessageId, updatedAt: new Date() })
        .where(eq(loginChallenges.id, challengeId));
    },

    async consumeLoginChallenge(input) {
      return database.transaction(async (transaction) => {
        const result = await transaction.execute<{
          challenge_id: string;
          user_id: string;
          workspace_id: string;
          role: 'owner' | 'admin' | 'editor' | 'viewer';
          redirect_path: string;
          correlation_id: string;
        }>(sql`
          SELECT challenge.id AS challenge_id, challenge.user_id, users.default_workspace_id AS workspace_id,
                 memberships.role, challenge.redirect_path, challenge.correlation_id
          FROM login_challenges AS challenge
          JOIN users ON users.id = challenge.user_id
          JOIN memberships ON memberships.user_id = users.id
            AND memberships.workspace_id = users.default_workspace_id
          WHERE challenge.token_hash = ${input.tokenHash}
            AND challenge.user_agent_hash = ${input.userAgentHash}
            AND challenge.purpose = 'login'
            AND challenge.delivery_state = 'sent'
            AND challenge.consumed_at IS NULL
            AND challenge.expires_at > now()
            AND users.is_disabled = false
          FOR UPDATE OF challenge
        `);
        const challenge = result.rows[0];
        if (!challenge) return null;
        await transaction.execute(
          sql`select set_config('app.workspace_id', ${challenge.workspace_id}, true)`,
        );
        await transaction
          .update(loginChallenges)
          .set({ consumedAt: input.now, updatedAt: input.now })
          .where(
            and(
              eq(loginChallenges.id, challenge.challenge_id),
              sql`${loginChallenges.consumedAt} is null`,
            ),
          );
        await transaction
          .update(sessions)
          .set({ revokedAt: input.now, updatedAt: input.now })
          .where(
            and(
              eq(sessions.workspaceId, challenge.workspace_id),
              eq(sessions.userId, challenge.user_id),
              sql`${sessions.revokedAt} is null`,
            ),
          );
        await transaction
          .update(users)
          .set({ passwordHash: null, updatedAt: input.now })
          .where(eq(users.id, challenge.user_id));
        await transaction.insert(sessions).values({
          userId: challenge.user_id,
          workspaceId: challenge.workspace_id,
          tokenHash: input.sessionTokenHash,
          csrfSecretHash: input.csrfSecretHash,
          expiresAt: input.sessionExpiresAt,
        });
        await transaction.insert(auditEvents).values({
          workspaceId: challenge.workspace_id,
          actorType: 'user',
          actorId: challenge.user_id,
          action: 'auth.magic_link.consumed',
          targetType: 'session',
          requestId: challenge.correlation_id,
          metadata: { purpose: 'login' },
        });
        return {
          userId: challenge.user_id,
          workspaceId: challenge.workspace_id,
          role: challenge.role,
          redirectPath: challenge.redirect_path,
        };
      });
    },

    async consumeSignupChallenge(input) {
      return database.transaction(async (transaction) => {
        const result = await transaction.execute<{
          challenge_id: string;
          redirect_path: string;
          correlation_id: string;
        }>(sql`
          SELECT id AS challenge_id, redirect_path, correlation_id
          FROM login_challenges
          WHERE token_hash = ${input.tokenHash} AND user_agent_hash = ${input.userAgentHash}
            AND purpose = 'signup' AND delivery_state = 'sent' AND consumed_at IS NULL
            AND expires_at > now()
          FOR UPDATE
        `);
        const challenge = result.rows[0];
        if (!challenge) return null;
        await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${input.email}))`);
        const [existingUser] = await transaction
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(${users.email}) = ${input.email}`)
          .limit(1);
        if (existingUser) return null;
        const [user] = await transaction
          .insert(users)
          .values({ displayName: input.displayName, email: input.email, passwordHash: null })
          .returning({ id: users.id });
        if (!user) return null;
        const [workspace] = await transaction
          .insert(workspaces)
          .values({ name: input.workspaceName, slug: createWorkspaceSlug(input.workspaceName) })
          .returning({ id: workspaces.id });
        if (!workspace) throw new Error('Signup workspace was not created');
        await transaction.execute(
          sql`select set_config('app.workspace_id', ${workspace.id}, true)`,
        );
        await transaction.insert(memberships).values({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'owner',
        });
        await transaction
          .update(users)
          .set({ defaultWorkspaceId: workspace.id })
          .where(eq(users.id, user.id));
        await transaction
          .update(loginChallenges)
          .set({ consumedAt: input.now, updatedAt: input.now })
          .where(eq(loginChallenges.id, challenge.challenge_id));
        await transaction.insert(sessions).values({
          userId: user.id,
          workspaceId: workspace.id,
          tokenHash: input.sessionTokenHash,
          csrfSecretHash: input.csrfSecretHash,
          expiresAt: input.sessionExpiresAt,
        });
        await transaction.insert(auditEvents).values({
          workspaceId: workspace.id,
          actorType: 'user',
          actorId: user.id,
          action: 'auth.magic_link.consumed',
          targetType: 'session',
          requestId: challenge.correlation_id,
          metadata: { purpose: 'signup' },
        });
        return {
          userId: user.id,
          workspaceId: workspace.id,
          role: 'owner' as const,
          redirectPath: challenge.redirect_path,
        };
      });
    },

    async cleanupExpired() {
      const deletedChallenges = await database
        .delete(loginChallenges)
        .where(lt(loginChallenges.expiresAt, sql`now()`))
        .returning({ id: loginChallenges.id });
      await database
        .delete(authRateLimitBuckets)
        .where(lt(authRateLimitBuckets.expiresAt, sql`now()`));
      return deletedChallenges.length;
    },
  };
}
