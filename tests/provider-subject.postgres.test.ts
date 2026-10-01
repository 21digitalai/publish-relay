import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { FakeProviderConnectionAdapter } from '../src/modules/credentials/provider-adapter.js';
import { connectProvider } from '../src/modules/credentials/provider-connection.service.js';
import {
  disconnectProviderSubject,
  rotateProviderSubjectCredential,
} from '../src/modules/credentials/provider-subject.service.js';
import type { EncryptedCredential } from '../src/modules/credentials/envelope.js';

const connectionString = process.env.POSTGRES_SUBJECT_TEST_URL;

function encrypted(marker: number): EncryptedCredential {
  const bytes = (value: number) => Buffer.from([value]);
  return {
    keyVersion: `v${String(marker)}`,
    wrappedKey: bytes(marker),
    wrappedKeyNonce: bytes(2),
    wrappedKeyTag: bytes(3),
    ciphertext: bytes(4),
    nonce: bytes(5),
    tag: bytes(6),
  };
}

describe.skipIf(!connectionString)('subject connection lifecycle on PostgreSQL', () => {
  it.each(['x', 'youtube', 'meta'])(
    'isolates two %s grant principals on real PostgreSQL',
    async (provider) => {
      const pool = new pg.Pool({ connectionString });
      const database = drizzle(pool);
      const workspaceId = randomUUID();
      const userId = randomUUID();
      const keys = {
        currentVersion: () => 'v1',
        getKey: () => Promise.resolve(Buffer.alloc(32, 7)),
      };
      try {
        await pool.query('INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)', [
          workspaceId,
          'Subject Family Test',
          workspaceId,
        ]);
        await pool.query(
          'INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)',
          [userId, `${userId}@example.test`, 'redacted', 'Subject Family Tester'],
        );
        await pool.query(
          'INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)',
          [workspaceId, userId, 'owner'],
        );
        const destinationProvider =
          provider === 'meta' ? ('facebook_page' as const) : (provider as 'x' | 'youtube');
        const connect = (subject: string, destination: string, token: string) =>
          connectProvider(
            database,
            keys,
            new FakeProviderConnectionAdapter([
              {
                providerAccountId: destination,
                remoteAccountId: destination,
                destinationProvider,
                displayName: destination,
              },
            ]),
            {
              workspaceId,
              userId,
              provider,
              externalSubjectId: subject,
              accessToken: token,
              requestId: randomUUID(),
            },
          );
        const first = await connect('principal-one', 'destination-one', 'first');
        const sibling = await connect('principal-two', 'destination-two', 'second');
        expect(first.connectionId).not.toBe(sibling.connectionId);
        expect(
          (await connect('principal-one', 'destination-one', 'replacement')).connectionId,
        ).toBe(first.connectionId);
        await expect(connect('principal-three', 'destination-two', 'conflict')).rejects.toThrow(
          'manual resolution required',
        );
        const rows = await pool.query<{ external_subject_id: string; credential_id: string }>(
          'SELECT external_subject_id, credential_id FROM provider_connections WHERE workspace_id = $1 ORDER BY external_subject_id',
          [workspaceId],
        );
        expect(rows.rows.map((row) => row.external_subject_id)).toEqual([
          'principal-one',
          'principal-two',
        ]);
        const siblingCredential = rows.rows[1]?.credential_id;
        await pool.query('UPDATE provider_connections SET external_subject_id = $1 WHERE id = $2', [
          `legacy:${sibling.connectionId}`,
          sibling.connectionId,
        ]);
        await expect(connect('principal-two', 'destination-two', 'new-grant')).rejects.toThrow(
          'manual resolution required',
        );
        const retained = await pool.query<{ credential_id: string }>(
          'SELECT credential_id FROM provider_connections WHERE id = $1',
          [sibling.connectionId],
        );
        expect(retained.rows[0]?.credential_id).toBe(siblingCredential);
      } finally {
        await pool.end();
      }
    },
  );

  it('isolates subjects and tenants, rotates atomically, and refuses unresolved jobs on disconnect', async () => {
    const pool = new pg.Pool({ connectionString });
    const database = drizzle(pool);
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const userId = randomUUID();
    const keys = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(Buffer.alloc(32, 7)),
    };
    try {
      await pool.query(
        `INSERT INTO workspaces (id, name, slug) VALUES
         ($1, 'Subject Test', $3), ($2, 'Other Subject Test', $4)`,
        [workspaceId, otherWorkspaceId, workspaceId, otherWorkspaceId],
      );
      await pool.query(
        `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'redacted', 'Subject Tester')`,
        [userId, `${userId}@example.test`],
      );
      await pool.query(
        `INSERT INTO memberships (workspace_id, user_id, role) VALUES
         ($1, $3, 'owner'), ($2, $3, 'owner')`,
        [workspaceId, otherWorkspaceId, userId],
      );
      const connect = (workspace: string, subject: string, token: string) =>
        connectProvider(
          database,
          keys,
          new FakeProviderConnectionAdapter([{ providerAccountId: subject, displayName: subject }]),
          {
            workspaceId: workspace,
            userId,
            provider: 'tiktok',
            externalSubjectId: subject,
            accessToken: token,
            requestId: randomUUID(),
          },
        );
      const first = await connect(workspaceId, 'subject-one', 'first');
      const sibling = await connect(workspaceId, 'subject-two', 'second');
      const foreign = await connect(otherWorkspaceId, 'subject-one', 'foreign');
      expect(new Set([first.connectionId, sibling.connectionId, foreign.connectionId]).size).toBe(
        3,
      );
      const reconnectPostId = randomUUID();
      const reconnectRevisionId = randomUUID();
      const firstAccount = await pool.query<{ id: string }>(
        'SELECT id FROM provider_accounts WHERE connection_id = $1',
        [first.connectionId],
      );
      await pool.query(
        'INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ($1, $2, $3)',
        [reconnectPostId, workspaceId, userId],
      );
      await pool.query(
        'INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content) VALUES ($1, $2, $3, 1, $4)',
        [reconnectRevisionId, workspaceId, reconnectPostId, '{}'],
      );
      await pool.query(
        `INSERT INTO publication_jobs
        (workspace_id, post_id, revision_id, provider_account_id, scheduled_at, state)
        VALUES ($1, $2, $3, $4, now(), 'scheduled')`,
        [workspaceId, reconnectPostId, reconnectRevisionId, firstAccount.rows[0]?.id],
      );
      expect((await connect(workspaceId, 'subject-one', 'replacement')).connectionId).toBe(
        first.connectionId,
      );
      const retainedJob = await pool.query<{ provider_account_id: string; state: string }>(
        'SELECT provider_account_id, state FROM publication_jobs WHERE post_id = $1',
        [reconnectPostId],
      );
      expect(retainedJob.rows).toEqual([
        { provider_account_id: firstAccount.rows[0]?.id, state: 'scheduled' },
      ]);

      const rotate = (workspace: string, expectedVersion: number, marker: number) =>
        rotateProviderSubjectCredential(database, {
          workspaceId: workspace,
          provider: 'tiktok',
          externalSubjectId: 'subject-one',
          expectedVersion,
          encrypted: encrypted(marker),
          scopes: ['video.publish'],
          accessExpiresAt: new Date('2026-11-01T00:00:00Z'),
          refreshExpiresAt: null,
          requestId: randomUUID(),
        });
      expect(await rotate(workspaceId, 1, 9)).toBe(true);
      expect(await rotate(workspaceId, 1, 10)).toBe(false);
      const versions = await pool.query<{ workspace_id: string; version: number }>(
        `SELECT pc.workspace_id, c.version FROM provider_connections pc
         JOIN credentials c ON c.id = pc.credential_id
         WHERE pc.external_subject_id = 'subject-one' ORDER BY pc.workspace_id`,
      );
      expect(versions.rows.find((row) => row.workspace_id === workspaceId)?.version).toBe(2);
      expect(versions.rows.find((row) => row.workspace_id === otherWorkspaceId)?.version).toBe(1);

      const postId = randomUUID();
      const revisionId = randomUUID();
      const account = await pool.query<{ id: string }>(
        `SELECT id FROM provider_accounts WHERE connection_id = $1`,
        [first.connectionId],
      );
      await pool.query(
        `INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ($1, $2, $3)`,
        [postId, workspaceId, userId],
      );
      await pool.query(
        `INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
         VALUES ($1, $2, $3, 1, '{}')`,
        [revisionId, workspaceId, postId],
      );
      await pool.query(
        `INSERT INTO publication_jobs
         (workspace_id, post_id, revision_id, provider_account_id, scheduled_at, state)
         VALUES ($1, $2, $3, $4, now(), 'accepted_pending')`,
        [workspaceId, postId, revisionId, account.rows[0]?.id],
      );
      const disconnect = () =>
        disconnectProviderSubject(database, {
          workspaceId,
          userId,
          provider: 'tiktok',
          externalSubjectId: 'subject-one',
          requestId: randomUUID(),
        });
      await expect(disconnect()).rejects.toThrow('Scheduled publications must be resolved');
      await pool.query(`UPDATE publication_jobs SET state = 'published' WHERE post_id = $1`, [
        postId,
      ]);
      await pool.query(`UPDATE publication_jobs SET state = 'published' WHERE post_id = $1`, [
        reconnectPostId,
      ]);
      expect(await disconnect()).toBe(true);
      const states = await pool.query<{
        workspace_id: string;
        external_subject_id: string;
        status: string;
      }>(
        `SELECT workspace_id, external_subject_id, status FROM provider_connections
         WHERE provider = 'tiktok' AND workspace_id IN ($1, $2)`,
        [workspaceId, otherWorkspaceId],
      );
      expect(states.rows).toContainEqual({
        workspace_id: workspaceId,
        external_subject_id: 'subject-one',
        status: 'revoked',
      });
      expect(states.rows.filter((row) => row.status === 'active')).toHaveLength(2);
      const tenantClient = await pool.connect();
      try {
        await tenantClient.query('BEGIN');
        await tenantClient.query('SET LOCAL ROLE publish_relay_web');
        await tenantClient.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
        const visible = await tenantClient.query<{ external_subject_id: string }>(
          `SELECT external_subject_id FROM provider_connections ORDER BY external_subject_id`,
        );
        expect(visible.rows.map((row) => row.external_subject_id)).toEqual([
          'subject-one',
          'subject-two',
        ]);
        await tenantClient.query(`SELECT set_config('app.workspace_id', $1, true)`, [
          otherWorkspaceId,
        ]);
        const otherVisible = await tenantClient.query<{ external_subject_id: string }>(
          `SELECT external_subject_id FROM provider_connections`,
        );
        expect(otherVisible.rows.map((row) => row.external_subject_id)).toEqual(['subject-one']);
      } finally {
        await tenantClient.query('ROLLBACK');
        tenantClient.release();
      }
    } finally {
      await pool.end();
    }
  });
});
