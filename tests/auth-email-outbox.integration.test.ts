import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MasterKeyProvider } from '../src/modules/credentials/envelope.js';
import {
  AuthEmailOutboxDelivery,
  dispatchAuthEmailOutbox,
} from '../src/modules/identity/auth-email-outbox.js';
import type { EmailDelivery } from '../src/modules/identity/magic-link.service.js';

class TestKeys implements MasterKeyProvider {
  private readonly key = randomBytes(32);
  currentVersion(): string {
    return 'v1';
  }
  getKey(): Promise<Buffer> {
    return Promise.resolve(this.key);
  }
}

let database: PGlite;

beforeEach(async () => {
  database = new PGlite();
  for (const name of [
    '0000_identity_tenancy.sql',
    '0001_solid_spiral.sql',
    '0040_ambiguous_loners.sql',
    '0041_chilly_bug.sql',
  ])
    await database.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
});

afterEach(async () => database.close());

describe('auth email outbox', () => {
  const challenge = {
    userId: null,
    tokenHash: 'token-hash',
    emailKeyHash: 'email-hash',
    networkKeyHash: 'network-hash',
    userAgentHash: 'agent-hash',
    purpose: 'login' as const,
    redirectPath: '/app',
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    correlationId: 'request-1',
  };

  it('atomically creates the challenge and encrypted delivery row', async () => {
    const outbox = new AuthEmailOutboxDelivery(
      drizzle(database) as unknown as NodePgDatabase,
      new TestKeys(),
    );
    await outbox.queueMagicLinkChallenge(challenge, {
      recipient: 'owner@example.test',
      url: 'https://relay.example/verify?token=raw-secret',
      correlationId: 'request-1',
    });
    const counts = await database.query<{ challenges: number; emails: number }>(`
      SELECT (SELECT count(*) FROM login_challenges)::int AS challenges,
             (SELECT count(*) FROM auth_email_outbox)::int AS emails
    `);
    expect(counts.rows).toEqual([{ challenges: 1, emails: 1 }]);
  });

  it('rolls back the challenge when the outbox write fails', async () => {
    await database.exec('DROP TABLE auth_email_outbox');
    const outbox = new AuthEmailOutboxDelivery(
      drizzle(database) as unknown as NodePgDatabase,
      new TestKeys(),
    );
    await expect(
      outbox.queueMagicLinkChallenge(challenge, {
        recipient: 'owner@example.test',
        url: 'https://relay.example/verify?token=raw-secret',
        correlationId: 'request-1',
      }),
    ).rejects.toThrow();
    const stored = await database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM login_challenges',
    );
    expect(stored.rows).toEqual([{ count: 0 }]);
  });

  it('persists only encrypted delivery material and dispatches it once', async () => {
    const challengeId = '00000000-0000-4000-8000-000000000921';
    await database.exec(`
      INSERT INTO login_challenges
        (id, token_hash, email_key_hash, network_key_hash, user_agent_hash, purpose,
         redirect_path, delivery_state, correlation_id, expires_at)
      VALUES ('${challengeId}', 'token-hash', 'email-hash', 'network-hash', 'agent-hash',
        'login', '/app', 'pending', 'request-1', '2030-01-01T00:00:00Z');
    `);
    const keys = new TestKeys();
    const drizzleDatabase = drizzle(database) as unknown as NodePgDatabase;
    const outbox = new AuthEmailOutboxDelivery(drizzleDatabase, keys);
    await outbox.sendMagicLink({
      challengeId,
      recipient: 'owner@example.test',
      url: 'https://relay.example/api/auth/magic-link/verify?token=raw-secret',
      correlationId: 'request-1',
    });
    const stored = await database.query<{ payload: string }>(
      `SELECT encode(ciphertext, 'escape') AS payload FROM auth_email_outbox`,
    );
    expect(stored.rows[0]?.payload).not.toContain('owner@example.test');
    expect(stored.rows[0]?.payload).not.toContain('raw-secret');

    const provider = {
      sendMagicLink: vi.fn().mockResolvedValue({ messageId: 'resend-1' }),
    } satisfies EmailDelivery;
    await expect(
      dispatchAuthEmailOutbox(drizzleDatabase, keys, provider, {
        workerId: 'worker-1',
        now: new Date('2029-12-01T00:00:00Z'),
        leaseMs: 30_000,
      }),
    ).resolves.toEqual({ sent: 1, failed: 0 });
    expect(provider.sendMagicLink).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: 'owner@example.test', correlationId: 'request-1' }),
    );
    const challenge = await database.query<{ delivery_state: string; provider_message_id: string }>(
      `SELECT delivery_state, provider_message_id FROM login_challenges`,
    );
    expect(challenge.rows).toEqual([{ delivery_state: 'sent', provider_message_id: 'resend-1' }]);
    await expect(
      dispatchAuthEmailOutbox(drizzleDatabase, keys, provider, {
        workerId: 'worker-1',
        now: new Date('2029-12-01T00:01:00Z'),
        leaseMs: 30_000,
      }),
    ).resolves.toEqual({ sent: 0, failed: 0 });
  });

  it('releases failed leases with backoff and recovers an expired lease exactly once', async () => {
    const keys = new TestKeys();
    const drizzleDatabase = drizzle(database) as unknown as NodePgDatabase;
    const outbox = new AuthEmailOutboxDelivery(drizzleDatabase, keys);
    await outbox.queueMagicLinkChallenge(challenge, {
      recipient: 'owner@example.test',
      url: 'https://relay.example/verify?token=raw-secret',
      correlationId: 'request-1',
    });
    const provider: EmailDelivery = {
      sendMagicLink: vi
        .fn()
        .mockRejectedValueOnce(new Error('provider unavailable'))
        .mockResolvedValue({ messageId: 'resend-2' }),
    };
    const failedAt = new Date('2029-12-01T00:00:00Z');
    await expect(
      dispatchAuthEmailOutbox(drizzleDatabase, keys, provider, {
        workerId: 'worker-1',
        now: failedAt,
        leaseMs: 30_000,
      }),
    ).resolves.toEqual({ sent: 0, failed: 1 });
    const retry = await database.query<{
      lease_owner: string | null;
      last_error_code: string;
      available_at: Date;
    }>('SELECT lease_owner, last_error_code, available_at FROM auth_email_outbox');
    expect(retry.rows[0]).toMatchObject({ lease_owner: null, last_error_code: 'delivery_failed' });
    await database.exec(`
      UPDATE auth_email_outbox SET lease_owner = 'dead-worker',
        lease_expires_at = '2029-12-01T00:00:01Z', available_at = '2029-12-01T00:00:00Z'
    `);
    const recoveredAt = new Date('2029-12-01T00:01:00Z');
    const results = await Promise.all([
      dispatchAuthEmailOutbox(drizzleDatabase, keys, provider, {
        workerId: 'worker-2',
        now: recoveredAt,
        leaseMs: 30_000,
      }),
      dispatchAuthEmailOutbox(drizzleDatabase, keys, provider, {
        workerId: 'worker-3',
        now: recoveredAt,
        leaseMs: 30_000,
      }),
    ]);
    expect(results.reduce((total, result) => total + result.sent, 0)).toBe(1);
    expect(vi.mocked(provider.sendMagicLink)).toHaveBeenCalledTimes(2);
  });
});
