import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { consumePersistentAuthRateLimit } from '../src/modules/identity/auth-rate-limit.repository.js';
import { AuthService, type AuthStore } from '../src/modules/identity/auth.service.js';
import {
  MagicLinkService,
  type MagicLinkStore,
} from '../src/modules/identity/magic-link.service.js';

const AUTH_RATE_LIMIT_SECRET = 'shared-auth-rate-limit-test-secret';

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
  it('shares secret-keyed account and network buckets across actual auth consumers', async () => {
    const consume = (input: { emailKeyHash: string; networkKeyHash: string }) =>
      consumePersistentAuthRateLimit(database, input);
    const magicStore = {
      findEnabledUserIdByEmail: () => Promise.resolve(null),
      consumeRateLimit: consume,
      createChallenge: () => Promise.resolve('unused'),
      markDelivery: () => Promise.resolve(),
      consumeLoginChallenge: () => Promise.resolve(null),
      consumeSignupChallenge: () => Promise.resolve(null),
    } satisfies MagicLinkStore;
    const magicLinks = new MagicLinkService(
      magicStore,
      { sendMagicLink: () => Promise.resolve({ messageId: 'unused' }) },
      {
        pepper: AUTH_RATE_LIMIT_SECRET,
        publicOrigin: 'https://relay.example',
        exposeDevelopmentUrl: false,
      },
    );
    const auth = new AuthService(
      { consumeReviewerRateLimit: consume } as unknown as AuthStore,
      undefined,
      AUTH_RATE_LIMIT_SECRET,
    );
    const request = {
      email: ' Reviewer@Example.Test ',
      networkKey: '203.0.113.10',
      userAgent: 'test',
      correlationId: 'rate-limit-regression',
    };

    for (let attempt = 0; attempt < 4; attempt += 1)
      await magicLinks.requestAccess({
        ...request,
        correlationId: `${request.correlationId}-${String(attempt)}`,
      });
    await expect(auth.admitReviewerLogin(request.email, request.networkKey)).resolves.toBe(true);
    await expect(auth.admitReviewerLogin(request.email, request.networkKey)).resolves.toBe(false);

    const buckets = await postgres.query<{
      kind: string;
      request_count: number;
    }>('SELECT kind, request_count FROM auth_rate_limit_buckets ORDER BY kind');
    expect(buckets.rows).toEqual([
      { kind: 'email', request_count: 6 },
      { kind: 'network', request_count: 6 },
    ]);
  });

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
