import { and, eq, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { authRateLimitBuckets, loginChallenges, users } from '../../database/schema.js';
import type { MagicLinkStore } from './magic-link.service.js';

const EMAIL_REQUESTS_PER_MINUTE = 5;
const NETWORK_REQUESTS_PER_MINUTE = 20;

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
