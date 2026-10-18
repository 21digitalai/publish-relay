import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { createPostgresAuthStore } from '../src/modules/identity/auth.repository.js';

const connectionString = process.env.POSTGRES_WORKSPACE_TEST_URL;

describe.skipIf(!connectionString)('workspace switch/deletion PostgreSQL concurrency', () => {
  it('keeps the current session when deletion commits before a waiting switch', async () => {
    const pool = new pg.Pool({ connectionString, max: 3 });
    const switchPool = new pg.Pool({
      connectionString,
      max: 1,
      application_name: 'workspace-switch-delete-race',
    });
    const deleting = await pool.connect();
    const userId = randomUUID();
    const currentWorkspaceId = randomUUID();
    const targetWorkspaceId = randomUUID();
    const currentTokenHash = 'a'.repeat(64);
    const nextTokenHash = 'b'.repeat(64);
    let switchResult:
      ReturnType<ReturnType<typeof createPostgresAuthStore>['rotateWorkspaceSession']> | undefined;
    try {
      await pool.query(
        `INSERT INTO workspaces (id, name, slug) VALUES
          ($1, 'Current', $3), ($2, 'Target', $4)`,
        [
          currentWorkspaceId,
          targetWorkspaceId,
          `current-${currentWorkspaceId}`,
          `target-${targetWorkspaceId}`,
        ],
      );
      await pool.query(
        `INSERT INTO users (id, email, display_name, password_hash, default_workspace_id)
          VALUES ($1, $2, 'Race Tester', 'redacted', $3)`,
        [userId, `${userId}@example.test`, currentWorkspaceId],
      );
      await pool.query(
        `INSERT INTO memberships (workspace_id, user_id, role) VALUES
          ($1, $3, 'owner'), ($2, $3, 'owner')`,
        [currentWorkspaceId, targetWorkspaceId, userId],
      );
      await pool.query(
        `INSERT INTO sessions (workspace_id, user_id, token_hash, csrf_secret_hash, expires_at)
          VALUES ($1, $2, $3, $4, now() + interval '1 day')`,
        [currentWorkspaceId, userId, currentTokenHash, 'c'.repeat(64)],
      );

      // Hold deletion's lock order while its tombstone is uncommitted. A plain
      // SELECT sees the old target here, but the switch must wait and recheck.
      await deleting.query('BEGIN');
      await deleting.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      await deleting.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [
        targetWorkspaceId,
      ]);
      await deleting.query('UPDATE workspaces SET deleted_at = now() WHERE id = $1', [
        targetWorkspaceId,
      ]);

      const store = createPostgresAuthStore(drizzle(switchPool));
      switchResult = store.rotateWorkspaceSession({
        currentWorkspaceId,
        currentTokenHash,
        targetWorkspaceId,
        userId,
        tokenHash: nextTokenHash,
        csrfSecretHash: 'd'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expectLockWait(pool);
      await deleting.query('COMMIT');

      await expect(switchResult).resolves.toBeNull();
      const sessions = await pool.query<{ workspace_id: string; revoked_at: Date | null }>(
        'SELECT workspace_id, revoked_at FROM sessions WHERE token_hash IN ($1, $2)',
        [currentTokenHash, nextTokenHash],
      );
      expect(sessions.rows).toEqual([{ workspace_id: currentWorkspaceId, revoked_at: null }]);
    } finally {
      await deleting.query('ROLLBACK');
      if (switchResult) await switchResult.catch(() => undefined);
      deleting.release();
      await switchPool.end();
      await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM memberships WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      await pool.query('DELETE FROM workspaces WHERE id IN ($1, $2)', [
        currentWorkspaceId,
        targetWorkspaceId,
      ]);
      await pool.end();
    }
  });
});

async function expectLockWait(pool: pg.Pool): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await pool.query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type FROM pg_stat_activity
       WHERE application_name = 'workspace-switch-delete-race' AND state = 'active'`,
    );
    if (result.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Workspace switch did not wait for the deletion lock');
}
