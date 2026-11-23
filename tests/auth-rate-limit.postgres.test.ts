import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { consumePersistentAuthRateLimit } from '../src/modules/identity/auth-rate-limit.repository.js';

let postgres: PGlite;
let database: NodePgDatabase;

beforeEach(async () => {
  postgres = new PGlite();
  await postgres.exec(`
    CREATE TABLE auth_rate_limit_buckets (
      kind text NOT NULL,
      key_hash text NOT NULL,
      window_started_at timestamptz NOT NULL,
      request_count integer NOT NULL DEFAULT 1,
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (kind, key_hash, window_started_at),
      CHECK (kind in ('email', 'network')),
      CHECK (request_count > 0)
    );
  `);
  database = drizzle(postgres) as unknown as NodePgDatabase;
});

afterEach(async () => postgres.close());

describe('persistent auth rate-limit repository', () => {
  it('shares the normalized-account threshold across auth consumers', async () => {
    const input = { emailKeyHash: 'same-account', networkKeyHash: 'network' };
    const decisions = [] as boolean[];
    for (let attempt = 0; attempt < 6; attempt += 1)
      decisions.push(await consumePersistentAuthRateLimit(database, input));
    expect(decisions).toEqual([true, true, true, true, true, false]);
    const email = await postgres.query<{ request_count: number }>(
      "SELECT request_count FROM auth_rate_limit_buckets WHERE kind='email'",
    );
    expect(email.rows).toEqual([{ request_count: 6 }]);
  });

  it('atomically enforces the shared network threshold across distinct accounts', async () => {
    const decisions = await Promise.all(
      Array.from({ length: 21 }, (_, index) =>
        consumePersistentAuthRateLimit(database, {
          emailKeyHash: `account-${String(index)}`,
          networkKeyHash: 'shared-network',
        }),
      ),
    );
    expect(decisions.filter(Boolean)).toHaveLength(20);
    expect(decisions.filter((decision) => !decision)).toHaveLength(1);
    const network = await postgres.query<{ request_count: number }>(
      "SELECT request_count FROM auth_rate_limit_buckets WHERE kind='network'",
    );
    expect(network.rows).toEqual([{ request_count: 21 }]);
  });
});
