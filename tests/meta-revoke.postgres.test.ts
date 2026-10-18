import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createPost } from '../src/modules/content/post.service.js';
import { FakeProviderConnectionAdapter } from '../src/modules/credentials/provider-adapter.js';
import { disconnectProviderAccount } from '../src/modules/credentials/provider-account.service.js';
import { connectProvider } from '../src/modules/credentials/provider-connection.service.js';
import { revokeMetaConnection } from '../src/modules/providers/meta-oauth.service.js';
import { editFacebookPageExposure } from '../src/modules/credentials/provider-account-exposure.service.js';

const connectionString = process.env.POSTGRES_SUBJECT_TEST_URL;

describe.skipIf(!connectionString)('Meta revoke reservation on PostgreSQL', () => {
  it('blocks reconnect/admission, preserves sibling, and recovers after remote-success/local-failure', async () => {
    const pool = new pg.Pool({ connectionString, max: 5 });
    const database = drizzle(pool);
    const workspaceId = randomUUID();
    const targetWorkspaceId = randomUUID();
    const userId = randomUUID();
    const keys = {
      currentVersion: () => 'v1',
      getKey: () => Promise.resolve(Buffer.alloc(32, 7)),
    };
    const connect = (subject: string, destination: string, token: string) =>
      connectProvider(
        database,
        keys,
        new FakeProviderConnectionAdapter([
          {
            providerAccountId: destination,
            remoteAccountId: destination,
            destinationProvider: 'facebook_page',
            displayName: destination,
          },
        ]),
        {
          workspaceId,
          userId,
          provider: 'meta',
          externalSubjectId: subject,
          accessToken: JSON.stringify({ accessToken: token }),
          requestId: randomUUID(),
        },
      );
    try {
      await pool.query('INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)', [
        workspaceId,
        'Meta Revoke Test',
        workspaceId,
      ]);
      await pool.query('INSERT INTO workspaces (id, name, slug) VALUES ($1, $2, $3)', [
        targetWorkspaceId,
        'Meta Revoke Exposed Target',
        targetWorkspaceId,
      ]);
      await pool.query(
        'INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)',
        [userId, `${userId}@example.test`, 'redacted', 'Meta Revoke Tester'],
      );
      await pool.query(
        'INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)',
        [workspaceId, userId, 'owner'],
      );
      await pool.query(
        'INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)',
        [targetWorkspaceId, userId, 'owner'],
      );
      const selected = await connect('meta-principal-one', 'page-one', 'grant-one');
      const sibling = await connect('meta-principal-two', 'page-two', 'grant-two');
      const account = await pool.query<{ id: string }>(
        'SELECT id FROM provider_accounts WHERE connection_id = $1',
        [selected.connectionId],
      );
      const accountId = account.rows[0]?.id;
      if (!accountId) throw new Error('Selected account fixture was not created');
      await expect(
        editFacebookPageExposure(database, {
          originWorkspaceId: workspaceId,
          targetWorkspaceId,
          accountId,
          userId,
          requestId: randomUUID(),
          expose: true,
        }),
      ).resolves.toBe('updated');
      const input = { workspaceId, userId, accountId, requestId: randomUUID() };
      const postInput = {
        workspaceId,
        userId,
        providerAccountIds: [accountId],
        mediaIds: [],
        content: { kind: 'link', text: 'Post', linkUrl: 'https://example.test/' },
        scheduledAt: new Date(Date.now() + 3_600_000),
      };
      const scheduled = await createPost(database, postInput);
      const exposedPostInput = { ...postInput, workspaceId: targetWorkspaceId };
      const exposedScheduled = await createPost(database, exposedPostInput);
      await expect(
        revokeMetaConnection(database, keys, { revoke: () => Promise.resolve() } as never, input),
      ).rejects.toThrow('Cancel or resolve scheduled publications');
      await pool.query('UPDATE publication_jobs SET state = $1 WHERE id = $2', [
        'cancelled',
        scheduled.jobIds[0],
      ]);
      await expect(
        revokeMetaConnection(database, keys, { revoke: () => Promise.resolve() } as never, input),
      ).rejects.toThrow('Cancel or resolve scheduled publications');
      await pool.query('UPDATE publication_jobs SET state = $1 WHERE id = $2', [
        'cancelled',
        exposedScheduled.jobIds[0],
      ]);

      await pool.query(`CREATE FUNCTION test_meta_finalization_failure() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.status = 'revoked' THEN RAISE EXCEPTION 'injected finalization failure'; END IF;
          RETURN NEW;
        END $$`);
      await pool.query(`CREATE TRIGGER test_meta_finalization_failure
        BEFORE UPDATE ON provider_connections FOR EACH ROW
        EXECUTE FUNCTION test_meta_finalization_failure()`);
      let enteredRemote!: () => void;
      const remoteEntered = new Promise<void>((resolve) => {
        enteredRemote = resolve;
      });
      let releaseRemote!: () => void;
      const remoteGate = new Promise<void>((resolve) => {
        releaseRemote = resolve;
      });
      const client = {
        revoke: vi.fn(async () => {
          enteredRemote();
          await remoteGate;
        }),
      };
      const revoking = revokeMetaConnection(database, keys, client as never, input);
      await remoteEntered;
      await expect(connect('meta-principal-one', 'page-one', 'new-grant')).rejects.toThrow(
        'being revoked',
      );
      await expect(createPost(database, postInput)).rejects.toThrow('revocation is pending');
      await expect(createPost(database, exposedPostInput)).rejects.toThrow('revocation is pending');
      await expect(
        disconnectProviderAccount(database, { ...input, requestId: randomUUID() }),
      ).resolves.toBe('revoking');
      const during = await pool.query<{ status: string; credential_id: string }>(
        'SELECT status, credential_id FROM provider_connections WHERE id = $1',
        [selected.connectionId],
      );
      expect(during.rows[0]?.status).toBe('revoking');
      releaseRemote();
      await expect(revoking).rejects.toThrow('revocation is pending');
      const afterFailure = await pool.query<{ status: string; credential_id: string }>(
        'SELECT status, credential_id FROM provider_connections WHERE id = $1',
        [selected.connectionId],
      );
      expect(afterFailure.rows[0]).toEqual(during.rows[0]);
      await pool.query('DROP TRIGGER test_meta_finalization_failure ON provider_connections');
      await pool.query('DROP FUNCTION test_meta_finalization_failure()');
      await expect(revokeMetaConnection(database, keys, client as never, input)).resolves.toBe(
        true,
      );
      const final = await pool.query<{ id: string; status: string; credential_id: string }>(
        'SELECT id, status, credential_id FROM provider_connections WHERE workspace_id = $1 ORDER BY external_subject_id',
        [workspaceId],
      );
      expect(final.rows.find((row) => row.id === selected.connectionId)).toMatchObject({
        status: 'revoked',
        credential_id: during.rows[0]?.credential_id,
      });
      expect(final.rows.find((row) => row.id === sibling.connectionId)?.status).toBe('active');
      expect(client.revoke).toHaveBeenCalledTimes(2);
    } finally {
      await pool.query(
        'DROP TRIGGER IF EXISTS test_meta_finalization_failure ON provider_connections',
      );
      await pool.query('DROP FUNCTION IF EXISTS test_meta_finalization_failure()');
      await pool.end();
    }
  });
});
