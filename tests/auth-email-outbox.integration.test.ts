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
});
