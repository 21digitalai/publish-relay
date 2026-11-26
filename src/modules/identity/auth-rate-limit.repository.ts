import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export const AUTH_EMAIL_REQUESTS_PER_MINUTE = 5;
export const AUTH_NETWORK_REQUESTS_PER_MINUTE = 20;

export async function consumePersistentAuthRateLimit(
  database: NodePgDatabase,
  input: { emailKeyHash: string; networkKeyHash: string },
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const increment = async (kind: 'email' | 'network', keyHash: string): Promise<number> => {
      const result = await transaction.execute<{ request_count: number }>(sql`
        INSERT INTO auth_rate_limit_buckets (
          kind, key_hash, window_started_at, expires_at
        ) VALUES (
          ${kind}, ${keyHash}, date_trunc('minute', now()),
          date_trunc('minute', now()) + interval '2 minutes'
        )
        ON CONFLICT (kind, key_hash, window_started_at)
        DO UPDATE SET request_count = auth_rate_limit_buckets.request_count + 1
        RETURNING request_count
      `);
      const count = result.rows[0]?.request_count;
      if (!count) throw new Error('Auth rate-limit bucket was not updated');
      return count;
    };
    const emailCount = await increment('email', input.emailKeyHash);
    const networkCount = await increment('network', input.networkKeyHash);
    return (
      emailCount <= AUTH_EMAIL_REQUESTS_PER_MINUTE &&
      networkCount <= AUTH_NETWORK_REQUESTS_PER_MINUTE
    );
  });
}
