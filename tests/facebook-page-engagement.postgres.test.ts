import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  authorizePageEngagement,
  readPageEngagementState,
  setPageEngagementModule,
} from '../src/modules/providers/facebook-page-engagement.service.js';
import {
  listPageEngagementPrincipals,
  setPageEngagementPrincipalGrants,
} from '../src/modules/providers/facebook-page-engagement-grants.service.js';
import { schedulePageDmGroup } from '../src/modules/providers/facebook-dm-group.repository.js';
import { isAllowedPageDmGroupDispatchInTransaction } from '../src/modules/providers/facebook-dm-pending.repository.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';

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
    const legacyClientId = randomUUID();
    const legacyDelegatedGrant = randomUUID();
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
            VALUES ($1, $2, $3, 'Fixture', $4, 'hash', $5)`,
          [
            id,
            owner,
            user,
            id,
            id === key
              ? ['destinations:read', 'comments:read', 'comments:send']
              : ['destinations:read'],
          ],
        );
      await pool.query(
        `INSERT INTO registered_clients (id, display_name, client_type, redirect_uris, allowed_scopes)
          VALUES ($1, 'Fixture', 'public', ARRAY['https://example.test/callback'], ARRAY['destinations:read', 'comments:propose'])`,
        [clientId],
      );
      await pool.query(
        `INSERT INTO delegated_grants (id, workspace_id, user_id, client_id, scopes)
          VALUES ($1, $2, $3, $4, ARRAY['destinations:read', 'comments:propose'])`,
        [delegatedGrant, owner, user, clientId],
      );
      await pool.query(
        `INSERT INTO registered_clients (id, display_name, client_type, redirect_uris, allowed_scopes)
          VALUES ($1, 'Legacy', 'public', ARRAY['https://example.test/callback'], ARRAY['destinations:read'])`,
        [legacyClientId],
      );
      await pool.query(
        `INSERT INTO delegated_grants (id, workspace_id, user_id, client_id, scopes)
          VALUES ($1, $2, $3, $4, ARRAY['destinations:read'])`,
        [legacyDelegatedGrant, owner, user, legacyClientId],
      );

      expect(
        await readPageEngagementState(database, { workspaceId: owner, accountId: page }),
      ).toEqual({
        comments: { localEnabled: false, providerGrant: 'unknown' },
        dms: { localEnabled: false, providerGrant: 'unknown' },
        dmDailyGroupLimitEnabled: false,
        dmDailyGroupMaximum: 1,
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
      expect(
        await setPageEngagementPrincipalGrants(database, {
          workspaceId: other,
          accountId: page,
          userId: user,
          requestId: 'wrong-workspace',
          principalKind: 'api-key',
          principalId: key,
          capabilities: ['comments:read'],
        }),
      ).toBe(false);
      expect(
        await setPageEngagementPrincipalGrants(database, {
          workspaceId: owner,
          accountId: page,
          userId: user,
          requestId: 'grant-read',
          principalKind: 'api-key',
          principalId: key,
          capabilities: ['comments:read'],
        }),
      ).toBe(true);
      expect(
        await listPageEngagementPrincipals(database, {
          workspaceId: owner,
          accountId: page,
          userId: user,
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'api-key', id: key, capabilities: ['comments:read'] }),
          expect.objectContaining({ kind: 'api-key', id: legacyKey, capabilities: [] }),
        ]),
      );
      expect(
        await listPageEngagementPrincipals(database, {
          workspaceId: other,
          accountId: page,
          userId: user,
        }),
      ).toBeNull();
      await expect(
        setPageEngagementPrincipalGrants(database, {
          workspaceId: owner,
          accountId: page,
          userId: user,
          requestId: 'ineligible-key',
          principalKind: 'api-key',
          principalId: legacyKey,
          capabilities: ['comments:read'],
        }),
      ).rejects.toThrow('Selected Page access exceeds the credential capabilities');
      await pool.query(
        "UPDATE api_keys SET capabilities=ARRAY['destinations:read', 'comments:read'] WHERE id=$1",
        [legacyKey],
      );
      expect(
        (
          await listPageEngagementPrincipals(database, {
            workspaceId: owner,
            accountId: page,
            userId: user,
          })
        )?.find((item) => item.id === legacyKey)?.capabilities,
      ).toEqual([]);
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
          SET comments_provider_grant = 'verified', comments_verified_at = now(),
              comments_credential_id = $3,
              comments_granted_scopes = '["pages_show_list", "pages_read_engagement"]'::jsonb
          WHERE workspace_id = $1 AND account_id = $2`,
        [owner, page, credential],
      );
      expect(await allowed(page, key, 'comments:read')).toBe(true);
      expect(await allowed(page, key, 'comments:send')).toBe(false);
      expect(await allowed(page, key, 'dms:read')).toBe(false);
      await setPageEngagementPrincipalGrants(database, {
        workspaceId: owner,
        accountId: page,
        userId: user,
        requestId: 'grant-propose',
        principalKind: 'delegated',
        principalId: delegatedGrant,
        capabilities: ['comments:propose'],
      });
      await pool.query(
        `UPDATE delegated_grants SET scopes=ARRAY['destinations:read', 'comments:propose'] WHERE id=$1`,
        [legacyDelegatedGrant],
      );
      await expect(
        setPageEngagementPrincipalGrants(database, {
          workspaceId: owner,
          accountId: page,
          userId: user,
          requestId: 'ineligible-delegated',
          principalKind: 'delegated',
          principalId: legacyDelegatedGrant,
          capabilities: ['comments:propose'],
        }),
      ).rejects.toThrow('Selected Page access exceeds the credential capabilities');
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
      const principals = await listPageEngagementPrincipals(database, {
        workspaceId: owner,
        accountId: page,
        userId: user,
      });
      expect(
        principals?.find((item) => item.id === legacyDelegatedGrant)?.eligibleCapabilities,
      ).toEqual([]);
      await pool.query(
        "UPDATE registered_clients SET allowed_scopes=ARRAY['destinations:read', 'comments:propose'] WHERE id=$1",
        [legacyClientId],
      );
      expect(
        await authorizePageEngagement(database, {
          workspaceId: owner,
          accountId: page,
          principal: { kind: 'delegated', actorId: legacyDelegatedGrant, workspaceId: owner },
          capability: 'comments:propose',
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
      await setPageEngagementModule(database, {
        workspaceId: owner,
        accountId: page,
        userId: user,
        requestId: 'fixture-comments-on-again',
        module: 'comments',
        enabled: true,
      });
      await setPageEngagementPrincipalGrants(database, {
        workspaceId: owner,
        accountId: page,
        userId: user,
        requestId: 'remove-read',
        principalKind: 'api-key',
        principalId: key,
        capabilities: [],
      });
      expect(await allowed(page, key, 'comments:read')).toBe(false);
      await setPageEngagementPrincipalGrants(database, {
        workspaceId: owner,
        accountId: page,
        userId: user,
        requestId: 'grant-send',
        principalKind: 'api-key',
        principalId: key,
        capabilities: ['comments:send'],
      });
      expect(await allowed(page, key, 'comments:send')).toBe(true);
      await pool.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1', [key]);
      expect(await allowed(page, key, 'comments:send')).toBe(false);
      const listed = await listPageEngagementPrincipals(database, {
        workspaceId: owner,
        accountId: page,
        userId: user,
      });
      expect(listed?.some((item) => item.kind === 'api-key' && item.id === key)).toBe(false);
      await pool.query('UPDATE delegated_grants SET revoked_at=now() WHERE id=$1', [
        delegatedGrant,
      ]);
      expect(
        await authorizePageEngagement(database, {
          workspaceId: owner,
          accountId: page,
          principal: { kind: 'delegated', actorId: delegatedGrant, workspaceId: owner },
          capability: 'comments:propose',
        }),
      ).toBe(false);
    } finally {
      await pool.query(
        'DELETE FROM provider_account_exposures WHERE workspace_id = ANY($1::uuid[])',
        [[owner, other]],
      );
      await pool.query('DELETE FROM provider_accounts WHERE workspace_id = $1', [owner]);
      await pool.query('DELETE FROM provider_connections WHERE workspace_id = $1', [owner]);
      await pool.query('DELETE FROM delegated_grants WHERE workspace_id = $1', [owner]);
      await pool.query('DELETE FROM registered_clients WHERE id = $1', [clientId]);
      await pool.query('DELETE FROM registered_clients WHERE id = $1', [legacyClientId]);
      await pool.query('DELETE FROM api_keys WHERE workspace_id = $1', [owner]);
      await pool.query('DELETE FROM credentials WHERE workspace_id = $1', [owner]);
      await deleteFixtureAudit(pool, owner);
      await pool.query('DELETE FROM workspaces WHERE id = $1', [other]);
      await pool.query('DELETE FROM workspaces WHERE id = $1', [owner]);
      await pool.query('DELETE FROM users WHERE id = $1', [user]);
      await pool.end();
    }
  });

  it('serializes the second daily group and rechecks fresh inbound at dispatch', async () => {
    const pool = new pg.Pool({ connectionString });
    const database = drizzle(pool);
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const credentialId = randomUUID();
    const connectionId = randomUUID();
    const accountId = randomUUID();
    const firstActionId = randomUUID();
    const conversationId = `daily-${randomUUID()}`;
    const actor = { type: 'api-key' as const, id: randomUUID() };
    try {
      await pool.query(
        'INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)',
        [userId, `${userId}@example.test`, 'hash', 'Daily fixture'],
      );
      await pool.query('INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)', [
        workspaceId,
        'Daily group fixture',
        workspaceId,
      ]);
      await pool.query(
        `INSERT INTO credentials
          (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag)
          VALUES ($1, $2, 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06')`,
        [credentialId, workspaceId],
      );
      await pool.query(
        `INSERT INTO provider_connections (id, workspace_id, provider, credential_id)
          VALUES ($1, $2, 'meta', $3)`,
        [connectionId, workspaceId, credentialId],
      );
      await pool.query(
        `INSERT INTO provider_accounts
          (id, workspace_id, connection_id, provider_account_id, display_name, destination_provider, remote_account_id)
          VALUES ($1, $2, $3, $4, 'Daily fixture', 'facebook_page', $4)`,
        [accountId, workspaceId, connectionId, accountId],
      );
      await pool.query(
        `INSERT INTO facebook_page_engagement_modules
          (workspace_id, account_id, dm_daily_group_limit_enabled, dm_daily_group_maximum)
          VALUES ($1, $2, true, 2)`,
        [workspaceId, accountId],
      );
      const first = await schedulePageDmGroup(database, {
        workspaceId,
        accountId,
        conversationId,
        clientActionId: firstActionId,
        texts: ['First'],
        expectedLatestInboundMessageId: 'inbound-1',
        latestInboundAt: new Date(Date.now() - 120_000),
        windowDeadline: new Date(Date.now() + 3_600_000),
        actor,
      });
      const confirmedAt = new Date(Date.now() - 30_000);
      await pool.query(
        "UPDATE facebook_page_dm_pending_intents SET status='confirmed' WHERE id=$1",
        [first.id],
      );
      await pool.query(
        `INSERT INTO facebook_page_dm_actions
          (workspace_id, account_id, client_action_id, conversation_id, request_fingerprint,
           state, final_exit, bio_link_mention, actor_type, actor_id, updated_at)
          VALUES ($1, $2, $3, $4, 'fixture', 'confirmed', false, false, 'api_key', $5, $6)`,
        [workspaceId, accountId, firstActionId, conversationId, actor.id, confirmedAt],
      );
      const latestInboundAt = new Date(confirmedAt.getTime() + 1_000);
      const attempts = await Promise.allSettled(
        ['inbound-2', 'inbound-3'].map((expectedLatestInboundMessageId) =>
          schedulePageDmGroup(database, {
            workspaceId,
            accountId,
            conversationId,
            clientActionId: randomUUID(),
            texts: ['Fallback'],
            expectedLatestInboundMessageId,
            latestInboundAt,
            windowDeadline: new Date(Date.now() + 3_600_000),
            actor,
          }),
        ),
      );
      expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const second = attempts.find((result) => result.status === 'fulfilled');
      if (!second) throw new Error('Second group was not scheduled');
      await pool.query(
        `UPDATE facebook_page_dm_pending_intents
          SET status='claimed', lease_owner='pg-test', lease_until=now() + interval '1 minute'
          WHERE id=$1`,
        [second.value.id],
      );
      const claimedResult = await pool.query<{
        client_action_id: string;
        text_body: string;
      }>('SELECT client_action_id, text_body FROM facebook_page_dm_pending_intents WHERE id=$1', [
        second.value.id,
      ]);
      const claimed = claimedResult.rows[0];
      const candidate = {
        workspaceId,
        accountId,
        conversationId,
        clientActionId: claimed?.client_action_id ?? '',
        text: claimed?.text_body ?? '',
        actor,
        scheduledIntentId: second.value.id,
      };
      await withTenantTransaction(database, candidate, async (tx) => {
        expect(
          await isAllowedPageDmGroupDispatchInTransaction(tx, {
            ...candidate,
            latestInboundAt: new Date(confirmedAt.getTime() - 1_000),
          }),
        ).toBe(false);
        expect(
          await isAllowedPageDmGroupDispatchInTransaction(tx, { ...candidate, latestInboundAt }),
        ).toBe(true);
      });
    } finally {
      await pool.query(
        'DELETE FROM provider_account_exposures WHERE workspace_id=$1 OR provider_account_id=$2',
        [workspaceId, accountId],
      );
      await pool.query('DELETE FROM facebook_page_dm_pending_intents WHERE workspace_id=$1', [
        workspaceId,
      ]);
      await pool.query('DELETE FROM facebook_page_dm_actions WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM provider_accounts WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM provider_connections WHERE workspace_id=$1', [workspaceId]);
      await pool.query('DELETE FROM credentials WHERE workspace_id=$1', [workspaceId]);
      await deleteFixtureAudit(pool, workspaceId);
      await pool.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
      await pool.query('DELETE FROM users WHERE id=$1', [userId]);
      await pool.end();
    }
  });
});
