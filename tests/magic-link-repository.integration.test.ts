import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPostgresMagicLinkStore } from '../src/modules/identity/magic-link.repository.js';

let database: PGlite;

beforeEach(async () => {
  database = new PGlite();
  await database.exec(
    await readFile(new URL('../migrations/0000_identity_tenancy.sql', import.meta.url), 'utf8'),
  );
  await database.exec(
    await readFile(new URL('../migrations/0001_solid_spiral.sql', import.meta.url), 'utf8'),
  );
  await database.exec(
    await readFile(new URL('../migrations/0040_ambiguous_loners.sql', import.meta.url), 'utf8'),
  );
});

afterEach(async () => database.close());

describe('PostgreSQL magic-link repository', () => {
  it('atomically consumes one bound login challenge and issues exactly one session', async () => {
    const userId = '00000000-0000-4000-8000-000000000911';
    const workspaceId = '00000000-0000-4000-8000-000000000912';
    await database.exec(`
      INSERT INTO workspaces (id, name, slug) VALUES ('${workspaceId}', 'Magic', 'magic');
      INSERT INTO users (id, email, password_hash, default_workspace_id)
        VALUES ('${userId}', 'magic@example.test', NULL, '${workspaceId}');
      SELECT set_config('app.workspace_id', '${workspaceId}', false);
      INSERT INTO memberships (workspace_id, user_id, role)
        VALUES ('${workspaceId}', '${userId}', 'owner');
      INSERT INTO login_challenges
        (user_id, token_hash, email_key_hash, network_key_hash, user_agent_hash, purpose,
         redirect_path, delivery_state, correlation_id, expires_at)
        VALUES ('${userId}', 'token-hash', 'email-hash', 'network-hash', 'agent-hash',
                'login', '/app', 'sent', 'request-1', '2030-01-01T00:00:00Z');
    `);
    const store = createPostgresMagicLinkStore(drizzle(database) as unknown as NodePgDatabase);
    const input = {
      tokenHash: 'token-hash',
      userAgentHash: 'agent-hash',
      sessionTokenHash: 'session-hash',
      csrfSecretHash: 'csrf-hash',
      sessionExpiresAt: new Date('2030-02-01T00:00:00Z'),
      now: new Date('2029-12-01T00:00:00Z'),
    };

    await expect(store.consumeLoginChallenge(input)).resolves.toEqual({
      userId,
      workspaceId,
      role: 'owner',
      redirectPath: '/app',
    });
    await expect(store.consumeLoginChallenge(input)).resolves.toBeNull();
    const rows = await database.query<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(rows.rows).toEqual([{ token_hash: 'session-hash' }]);
  });

  it('rejects a challenge presented from a different user-agent binding', async () => {
    const store = createPostgresMagicLinkStore(drizzle(database) as unknown as NodePgDatabase);
    await expect(
      store.consumeLoginChallenge({
        tokenHash: 'missing',
        userAgentHash: 'wrong-agent',
        sessionTokenHash: 'session-hash',
        csrfSecretHash: 'csrf-hash',
        sessionExpiresAt: new Date('2030-02-01T00:00:00Z'),
        now: new Date('2029-12-01T00:00:00Z'),
      }),
    ).resolves.toBeNull();
  });

  it('finds only enabled accounts and persists no raw identity material', async () => {
    const userId = '00000000-0000-4000-8000-000000000901';
    await database.exec(`
      INSERT INTO users (id, email, password_hash) VALUES
        ('${userId}', 'owner@example.test', NULL),
        ('00000000-0000-4000-8000-000000000902', 'disabled@example.test', NULL);
      UPDATE users SET is_disabled = true WHERE email = 'disabled@example.test';
    `);
    const store = createPostgresMagicLinkStore(drizzle(database) as unknown as NodePgDatabase);
    await expect(store.findEnabledUserIdByEmail('owner@example.test')).resolves.toBe(userId);
    await expect(store.findEnabledUserIdByEmail('disabled@example.test')).resolves.toBeNull();

    const challengeId = await store.createChallenge({
      userId,
      tokenHash: 'token-hash',
      emailKeyHash: 'email-hash',
      networkKeyHash: 'network-hash',
      userAgentHash: 'agent-hash',
      purpose: 'login',
      redirectPath: '/app',
      expiresAt: new Date(Date.now() + 60_000),
      correlationId: 'request-1',
    });
    expect(challengeId).toMatch(/^[a-f0-9-]{36}$/);
    await store.markDelivery(challengeId, 'sent', 'provider-message');
    const rows = await database.query<{ token_hash: string; provider_message_id: string }>(
      'SELECT token_hash, provider_message_id FROM login_challenges',
    );
    expect(rows.rows).toEqual([
      { token_hash: 'token-hash', provider_message_id: 'provider-message' },
    ]);
  });

  it('shares atomic email limits across store instances', async () => {
    const first = createPostgresMagicLinkStore(drizzle(database) as unknown as NodePgDatabase);
    const second = createPostgresMagicLinkStore(drizzle(database) as unknown as NodePgDatabase);
    const input = { emailKeyHash: 'email-hash', networkKeyHash: 'network-hash' };
    for (let count = 0; count < 4; count += 1)
      await expect(first.consumeRateLimit(input)).resolves.toBe(true);
    await expect(second.consumeRateLimit(input)).resolves.toBe(true);
    await expect(first.consumeRateLimit(input)).resolves.toBe(false);
  });
});
