import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  authorizePageEngagement,
  readPageEngagementState,
  setPageEngagementModule,
} from '../src/modules/providers/facebook-page-engagement.service.js';

const connectionString = process.env.POSTGRES_FACEBOOK_ENGAGEMENT_TEST_URL;

async function deleteFixtureAudit(pool: pg.Pool, workspaceId: string): Promise<void> {
  // The audit log is append-only for the application. The dedicated
  // migration-owner test connection removes only this fixture's rows.
  const cleanup = await pool.connect();
  try {
    await cleanup.query('BEGIN');
    await cleanup.query('SET LOCAL session_replication_role = replica');
    await cleanup.query('DELETE FROM audit_events WHERE workspace_id = $1', [workspaceId]);
    await cleanup.query('COMMIT');
  } catch (error) {
    await cleanup.query('ROLLBACK');
    throw error;
  } finally {
    cleanup.release();
  }
}

describe.skipIf(!connectionString)('Facebook Page engagement isolation on PostgreSQL', () => {
  it('defaults off, isolates sibling and exposed Pages, and requires an exact grant plus provider proof', async () => {
    const pool = new pg.Pool({ connectionString });
    const database = drizzle(pool);
    const owner = randomUUID();
    const other = randomUUID();
    const user = randomUUID();
    const credential = randomUUID();
    const connection = randomUUID();
    const page = randomUUID();
    const sibling = randomUUID();
    const key = randomUUID();
    const legacyKey = randomUUID();
    const clientId = randomUUID();
    const delegatedGrant = randomUUID();
    const principal = { kind: 'api-key' as const, actorId: key, workspaceId: owner };
    try {
      await pool.query(
        'INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)',
        [user, `${user}@example.test`, 'hash', 'Fixture'],
      );
      for (const workspaceId of [owner, other])
        await pool.query('INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)', [
          workspaceId,
          'Engagement fixture',
          workspaceId,
        ]);
      await pool.query(
        `INSERT INTO credentials
          (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
          VALUES ($1, $2, 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06')`,
        [credential, owner],
      );
      await pool.query(
        `INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
          VALUES ($1, $2, 'meta', $3)`,
        [connection, owner, credential],
      );
      for (const accountId of [page, sibling])
        await pool.query(
          `INSERT INTO provider_accounts
            (id, workspace_id, connection_id, provider_account_id, display_name, destination_provider, remote_account_id)
            VALUES ($1, $2, $3, $4, 'Fixture Page', 'facebook_page', $4)`,
          [accountId, owner, connection, accountId],
        );
      await pool.query(
        'INSERT INTO provider_account_exposures (workspace_id, provider_account_id) VALUES ($1, $2)',
        [other, page],
      );
      for (const id of [key, legacyKey])
        await pool.query(
          `INSERT INTO api_keys
            (id, workspace_id, created_by_user_id, label, prefix, secret_hash, capabilities)
            VALUES ($1, $2, $3, 'Fixture', $4, 'hash', ARRAY['destinations:read'])`,
          [id, owner, user, id],
        );
      await pool.query(
        `INSERT INTO registered_clients (id, display_name, client_type, redirect_uris, allowed_scopes)
          VALUES ($1, 'Fixture', 'public', ARRAY['https://example.test/callback'], ARRAY['destinations:read'])`,
        [clientId],
      );
      await pool.query(
        `INSERT INTO delegated_grants (id, workspace_id, user_id, client_id, scopes)
          VALUES ($1, $2, $3, $4, ARRAY['destinations:read'])`,
        [delegatedGrant, owner, user, clientId],
      );

      expect(
        await readPageEngagementState(database, { workspaceId: owner, accountId: page }),
      ).toEqual({
        comments: { localEnabled: false, providerGrant: 'unknown' },
        dms: { localEnabled: false, providerGrant: 'unknown' },
      });
      expect(
        await readPageEngagementState(database, { workspaceId: other, accountId: page }),
      ).toBeNull();
      await setPageEngagementModule(database, {
        workspaceId: owner,
        accountId: page,
        userId: user,
        requestId: 'fixture-comments-on',
        module: 'comments',
        enabled: true,
      });
      expect(
        (await readPageEngagementState(database, { workspaceId: owner, accountId: page }))?.dms,
      ).toEqual({ localEnabled: false, providerGrant: 'unknown' });
      expect(
        (await readPageEngagementState(database, { workspaceId: owner, accountId: sibling }))
          ?.comments.localEnabled,
      ).toBe(false);
      await pool.query(
        `INSERT INTO facebook_page_engagement_grants (workspace_id, account_id, api_key_id, capability)
          VALUES ($1, $2, $3, 'comments:read')`,
        [owner, page, key],
      );
      const allowed = (
        accountId: string,
        actorId: string,
        capability: 'comments:read' | 'comments:send' | 'dms:read',
      ) =>
        authorizePageEngagement(database, {
          workspaceId: owner,
          accountId,
          principal: { ...principal, actorId },
          capability,
        });
      expect(await allowed(page, key, 'comments:read')).toBe(false);
      await setPageEngagementModule(database, {
        workspaceId: owner,
        accountId: page,
        userId: user,
        requestId: 'fixture-dms-on',
        module: 'dms',
        enabled: true,
      });
      expect(await allowed(page, key, 'dms:read')).toBe(false);
      await pool.query(
        `UPDATE facebook_page_engagement_modules
          SET comments_provider_grant = 'verified', comments_verified_at = now()
          WHERE workspace_id = $1 AND account_id = $2`,
        [owner, page],
      );
      expect(await allowed(page, key, 'comments:read')).toBe(true);
      expect(await allowed(page, key, 'comments:send')).toBe(false);
      expect(await allowed(page, key, 'dms:read')).toBe(false);
      await pool.query(
        `INSERT INTO facebook_page_engagement_grants
          (workspace_id, account_id, delegated_grant_id, capability)
          VALUES ($1, $2, $3, 'comments:propose')`,
        [owner, page, delegatedGrant],
      );
      expect(
        await authorizePageEngagement(database, {
          workspaceId: owner,
          accountId: page,
          principal: { kind: 'delegated', actorId: delegatedGrant, workspaceId: owner },
          capability: 'comments:propose',
        }),
      ).toBe(true);
      expect(
        await authorizePageEngagement(database, {
          workspaceId: owner,
          accountId: page,
          principal: { kind: 'delegated', actorId: delegatedGrant, workspaceId: owner },
          capability: 'comments:send',
        }),
      ).toBe(false);
      expect(await allowed(page, legacyKey, 'comments:read')).toBe(false);
      expect(await allowed(sibling, key, 'comments:read')).toBe(false);
      expect(
        await authorizePageEngagement(database, {
          workspaceId: other,
          accountId: page,
          principal: { ...principal, workspaceId: other },
          capability: 'comments:read',
        }),
      ).toBe(false);
      await setPageEngagementModule(database, {
        workspaceId: owner,
        accountId: page,
        userId: user,
        requestId: 'fixture-comments-off',
        module: 'comments',
        enabled: false,
      });
      expect(await allowed(page, key, 'comments:read')).toBe(false);
    } finally {
      await pool.query(
        'DELETE FROM provider_account_exposures WHERE workspace_id = ANY($1::uuid[])',
        [[owner, other]],
      );
      await pool.query('DELETE FROM provider_accounts WHERE workspace_id = $1', [owner]);
      await pool.query('DELETE FROM provider_connections WHERE workspace_id = $1', [owner]);
      await pool.query('DELETE FROM delegated_grants WHERE workspace_id = $1', [owner]);
      await pool.query('DELETE FROM registered_clients WHERE id = $1', [clientId]);
      await pool.query('DELETE FROM api_keys WHERE workspace_id = $1', [owner]);
      await pool.query('DELETE FROM credentials WHERE workspace_id = $1', [owner]);
      await deleteFixtureAudit(pool, owner);
      await pool.query('DELETE FROM workspaces WHERE id = $1', [other]);
      await pool.query('DELETE FROM workspaces WHERE id = $1', [owner]);
      await pool.query('DELETE FROM users WHERE id = $1', [user]);
      await pool.end();
    }
  });
});
