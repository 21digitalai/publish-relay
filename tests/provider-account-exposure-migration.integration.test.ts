import { readFile, readdir } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const origin = '00000000-0000-4000-8000-000000000101';
const target = '00000000-0000-4000-8000-000000000102';
const account = '00000000-0000-4000-8000-000000000103';
const user = '00000000-0000-4000-8000-000000000104';
const connection = '00000000-0000-4000-8000-000000000105';
const post = '00000000-0000-4000-8000-000000000106';
const revision = '00000000-0000-4000-8000-000000000107';
const credential = '00000000-0000-4000-8000-000000000108';

describe('provider account exposure migration', () => {
  it('backfills an existing account and its historical job without changing their IDs', async () => {
    const database = new PGlite();
    try {
      const folder = new URL('../migrations/', import.meta.url);
      const names = (await readdir(folder))
        .filter((name) => /^\d{4}_.+\.sql$/.test(name) && !name.startsWith('0059_'))
        .sort();
      for (const name of names) await database.exec(await readFile(new URL(name, folder), 'utf8'));
      await database.exec(`
        INSERT INTO users (id, display_name, email, password_hash)
          VALUES ('${user}', 'Owner', 'owner@example.test', 'hash');
        INSERT INTO workspaces (id, name, slug) VALUES ('${origin}', 'Origin', 'origin');
        INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
          wrapped_key_tag, ciphertext, nonce, tag)
          VALUES ('${credential}', '${origin}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
        INSERT INTO provider_connections (id, workspace_id, provider, credential_id, status)
          VALUES ('${connection}', '${origin}', 'meta', '${credential}', 'active');
        INSERT INTO provider_accounts
          (id, workspace_id, connection_id, provider_account_id, destination_provider, remote_account_id, display_name)
          VALUES ('${account}', '${origin}', '${connection}', 'page', 'facebook_page', 'page', 'Page');
        INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ('${post}', '${origin}', '${user}');
        INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
          VALUES ('${revision}', '${origin}', '${post}', 1, '{"kind":"text","text":"hello"}');
        INSERT INTO publication_jobs (workspace_id, post_id, revision_id, provider_account_id, scheduled_at)
          VALUES ('${origin}', '${post}', '${revision}', '${account}', '2026-10-19T10:00:00Z');
      `);
      await database.exec(
        await readFile(
          new URL('../migrations/0059_provider_account_exposures.sql', import.meta.url),
          'utf8',
        ),
      );
      const rows = await database.query<{
        workspace_id: string;
        provider_account_id: string;
        show_other_workspace_posts: boolean;
      }>(
        'SELECT workspace_id, provider_account_id, show_other_workspace_posts FROM provider_account_exposures',
      );
      expect(rows.rows).toEqual([
        { workspace_id: origin, provider_account_id: account, show_other_workspace_posts: true },
      ]);
      expect(
        (await database.query('SELECT provider_account_id FROM publication_jobs')).rows,
      ).toEqual([{ provider_account_id: account }]);
    } finally {
      await database.close();
    }
  });

  it('keeps one origin account, admits a target-owned job, and hides the origin under RLS', async () => {
    const database = new PGlite();
    try {
      const folder = new URL('../migrations/', import.meta.url);
      const names = (await readdir(folder)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
      for (const name of names) await database.exec(await readFile(new URL(name, folder), 'utf8'));
      await database.exec(`
        CREATE ROLE publish_relay_app NOLOGIN NOBYPASSRLS;
        GRANT USAGE ON SCHEMA public TO publish_relay_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO publish_relay_app;
        INSERT INTO users (id, display_name, email, password_hash)
          VALUES ('${user}', 'Owner', 'owner@example.test', 'hash');
        INSERT INTO workspaces (id, name, slug) VALUES
          ('${origin}', 'Origin', 'origin'), ('${target}', 'Target', 'target');
        INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
          wrapped_key_tag, ciphertext, nonce, tag)
          VALUES ('${credential}', '${origin}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
        INSERT INTO provider_connections (id, workspace_id, provider, credential_id, status)
          VALUES ('${connection}', '${origin}', 'meta', '${credential}', 'active');
        INSERT INTO provider_accounts
          (id, workspace_id, connection_id, provider_account_id, destination_provider, remote_account_id, display_name)
          VALUES ('${account}', '${origin}', '${connection}', 'page', 'facebook_page', 'page', 'Page');
        INSERT INTO provider_account_exposures (workspace_id, provider_account_id)
          VALUES ('${target}', '${account}');
        INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES ('${post}', '${target}', '${user}');
        INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content)
          VALUES ('${revision}', '${target}', '${post}', 1, '{"kind":"text","text":"hello"}');
        SELECT set_config('app.workspace_id', '${target}', false);
        SET ROLE publish_relay_app;
        INSERT INTO publication_jobs (workspace_id, post_id, revision_id, provider_account_id, scheduled_at)
          VALUES ('${target}', '${post}', '${revision}', '${account}', '2026-10-19T10:00:00Z');
      `);
      const exposures = await database.query<{
        workspace_id: string;
        show_other_workspace_posts: boolean;
      }>(
        'SELECT workspace_id, show_other_workspace_posts FROM provider_account_exposures ORDER BY workspace_id',
      );
      expect(exposures.rows).toEqual([{ workspace_id: target, show_other_workspace_posts: true }]);
      expect((await database.query('SELECT id FROM provider_accounts')).rows).toEqual([]);
      expect((await database.query('SELECT id FROM publication_jobs')).rows).toHaveLength(1);
      await expect(
        database.exec(`INSERT INTO provider_account_exposures
        (workspace_id, provider_account_id) VALUES ('${target}', '${account}')`),
      ).rejects.toThrow();
      await database.exec(`RESET ROLE;
        UPDATE provider_account_exposures SET revoked_at = now()
          WHERE workspace_id = '${target}' AND provider_account_id = '${account}';
        SET ROLE publish_relay_app;`);
      expect((await database.query('SELECT id FROM publication_jobs')).rows).toHaveLength(1);
    } finally {
      await database.close();
    }
  });
});
