import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const connectionString = process.env.POSTGRES_CONCURRENCY_TEST_URL;
const describeWithPostgres = connectionString ? describe : describe.skip;

describeWithPostgres('delegated authorization PostgreSQL concurrency', () => {
  const pool = new pg.Pool({ connectionString, max: 4 });

  beforeAll(async () => {
    await pool.query(`
      DO $$ BEGIN
        CREATE ROLE publish_relay_web NOLOGIN NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
      GRANT USAGE ON SCHEMA public TO publish_relay_web;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO publish_relay_web;
      GRANT EXECUTE ON FUNCTION public.resolve_delegated_access_token(text, timestamptz) TO publish_relay_web;
      GRANT EXECUTE ON FUNCTION public.rotate_delegated_refresh_token(text, text, text, timestamptz, timestamptz, timestamptz) TO publish_relay_web;
      GRANT EXECUTE ON FUNCTION public.revoke_delegated_token_family(text, text, timestamptz, text) TO publish_relay_web;
    `);
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE delegated_tokens, delegated_authorization_codes, delegated_grants,
        registered_clients, api_keys, audit_events, users, workspaces
        CASCADE;
      INSERT INTO workspaces (id, name, slug)
        VALUES ('00000000-0000-4000-8000-000000000201', 'Concurrency', 'concurrency');
      INSERT INTO users (id, email, display_name, password_hash)
        VALUES ('00000000-0000-4000-8000-000000000299', 'concurrency@example.test', 'Concurrency Owner', 'hash');
      INSERT INTO registered_clients (id, display_name, client_type, redirect_uris, allowed_scopes)
        VALUES ('open-clips-dev', 'Open Clips', 'public', ARRAY['http://127.0.0.1/callback'], ARRAY['destinations:read']);
      INSERT INTO delegated_grants (id, workspace_id, user_id, client_id, scopes)
        VALUES ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000201',
          '00000000-0000-4000-8000-000000000299', 'open-clips-dev', ARRAY['destinations:read']);
      INSERT INTO delegated_tokens
        (workspace_id, grant_id, access_token_hash, refresh_token_hash, scopes, access_expires_at, refresh_expires_at)
        VALUES ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000202',
          'access-original', 'refresh-original', ARRAY['destinations:read'], now() + interval '15 minutes', now() + interval '30 days');
    `);
  });

  afterAll(async () => pool.end());

  it('revokes the replacement when refresh holds the grant lock first', async () => {
    const refreshClient = await pool.connect();
    const revokeClient = await pool.connect();
    try {
      await refreshClient.query('BEGIN');
      await refreshClient.query('SET LOCAL ROLE publish_relay_web');
      const refresh = await refreshClient.query(`SELECT * FROM rotate_delegated_refresh_token(
        'refresh-original', 'access-replacement', 'refresh-replacement',
        now() + interval '15 minutes', now() + interval '30 days', now())`);
      expect(refresh.rows).toHaveLength(1);

      await revokeClient.query('BEGIN');
      await revokeClient.query('SET LOCAL ROLE publish_relay_web');
      const revokePid = await backendPid(revokeClient);
      const revoke = revokeClient.query(`SELECT revoke_delegated_token_family(
        'refresh-original', 'open-clips-dev', now(), 'refresh-first')`);
      await expectLockWait(revokePid);
      await refreshClient.query('COMMIT');
      await revoke;
      await revokeClient.query('COMMIT');

      expect(await resolvedAccessCount('access-replacement')).toBe(0);
    } finally {
      await rollbackQuietly(refreshClient);
      await rollbackQuietly(revokeClient);
      refreshClient.release();
      revokeClient.release();
    }
  });

  it('prevents a late replacement when revocation holds the grant lock first', async () => {
    const revokeClient = await pool.connect();
    const refreshClient = await pool.connect();
    try {
      await revokeClient.query('BEGIN');
      await revokeClient.query('SET LOCAL ROLE publish_relay_web');
      await revokeClient.query(`SELECT revoke_delegated_token_family(
        'access-original', 'open-clips-dev', now(), 'revoke-first')`);

      await refreshClient.query('BEGIN');
      await refreshClient.query('SET LOCAL ROLE publish_relay_web');
      const refreshPid = await backendPid(refreshClient);
      const refresh = refreshClient.query(`SELECT * FROM rotate_delegated_refresh_token(
        'refresh-original', 'access-late', 'refresh-late',
        now() + interval '15 minutes', now() + interval '30 days', now())`);
      await expectLockWait(refreshPid);
      await revokeClient.query('COMMIT');
      expect((await refresh).rows).toHaveLength(0);
      await refreshClient.query('COMMIT');

      expect(await tokenCount('access-late')).toBe(0);
    } finally {
      await rollbackQuietly(revokeClient);
      await rollbackQuietly(refreshClient);
      revokeClient.release();
      refreshClient.release();
    }
  });

  async function expectLockWait(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await pool.query<{ waitEventType: string | null }>(
        'SELECT wait_event_type AS "waitEventType" FROM pg_stat_activity WHERE pid = $1',
        [pid],
      );
      if (result.rows[0]?.waitEventType === 'Lock') return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`PostgreSQL backend ${String(pid)} did not enter a lock wait`);
  }

  async function resolvedAccessCount(accessHash: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM resolve_delegated_access_token($1, now())',
      [accessHash],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function tokenCount(accessHash: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM delegated_tokens WHERE access_token_hash = $1',
      [accessHash],
    );
    return result.rows[0]?.count ?? 0;
  }
});

async function backendPid(client: pg.PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = result.rows[0]?.pid;
  if (!pid) throw new Error('PostgreSQL backend PID was unavailable');
  return pid;
}

async function rollbackQuietly(client: pg.PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}
