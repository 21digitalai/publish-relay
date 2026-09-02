import { readFile, readdir } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getWorkspaceUsageFacts } from '../src/modules/policy/usage-facts.js';

const workspaceA = '00000000-0000-4000-8000-000000000901';
const workspaceB = '00000000-0000-4000-8000-000000000902';
let database: PGlite;

async function migrateDatabase(): Promise<void> {
  const migrationDirectory = new URL('../migrations/', import.meta.url);
  const migrations = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    await database.exec(await readFile(new URL(migration, migrationDirectory), 'utf8'));
  }
}

beforeEach(async () => {
  database = new PGlite();
  await migrateDatabase();
  await database.exec(`
    CREATE ROLE publish_relay_app NOLOGIN NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO publish_relay_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO publish_relay_app;

    INSERT INTO users (id, display_name, email, password_hash) VALUES
      ('00000000-0000-4000-8000-000000000911', 'Operator A', 'a@example.test', 'hash'),
      ('00000000-0000-4000-8000-000000000912', 'Operator B', 'b@example.test', 'hash');
    INSERT INTO workspaces (id, name, slug) VALUES
      ('${workspaceA}', 'Workspace A', 'usage-a'),
      ('${workspaceB}', 'Workspace B', 'usage-b');

    SELECT set_config('app.workspace_id', '${workspaceA}', false);
    INSERT INTO memberships (workspace_id, user_id, role) VALUES
      ('${workspaceA}', '00000000-0000-4000-8000-000000000911', 'owner');
    INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce, wrapped_key_tag, ciphertext, nonce, tag) VALUES
      ('00000000-0000-4000-8000-000000000921', '${workspaceA}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06'),
      ('00000000-0000-4000-8000-000000000922', '${workspaceA}', 'v1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06');
    INSERT INTO provider_connections (id, workspace_id, provider, credential_id, status) VALUES
      ('00000000-0000-4000-8000-000000000931', '${workspaceA}', 'x', '00000000-0000-4000-8000-000000000921', 'active'),
      ('00000000-0000-4000-8000-000000000932', '${workspaceA}', 'facebook', '00000000-0000-4000-8000-000000000922', 'disconnected');
    INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, display_name) VALUES
      ('00000000-0000-4000-8000-000000000941', '${workspaceA}', '00000000-0000-4000-8000-000000000931', 'x-a', 'X A'),
      ('00000000-0000-4000-8000-000000000942', '${workspaceA}', '00000000-0000-4000-8000-000000000932', 'fb-a', 'Facebook A');
    INSERT INTO media_objects (workspace_id, storage_key, sha256, mime_type, byte_size, state) VALUES
      ('${workspaceA}', 'a-ready', 'sha-a', 'image/png', 100, 'ready'),
      ('${workspaceA}', 'a-deleted', 'sha-b', 'image/png', 900, 'deleted');
    INSERT INTO posts (id, workspace_id, created_by_user_id) VALUES
      ('00000000-0000-4000-8000-000000000951', '${workspaceA}', '00000000-0000-4000-8000-000000000911');
    INSERT INTO post_revisions (id, workspace_id, post_id, revision_number, content) VALUES
      ('00000000-0000-4000-8000-000000000961', '${workspaceA}', '00000000-0000-4000-8000-000000000951', 1, '{"kind":"text","text":"hello"}');
    INSERT INTO publication_jobs (id, workspace_id, post_id, revision_id, provider_account_id, scheduled_at) VALUES
      ('00000000-0000-4000-8000-000000000971', '${workspaceA}', '00000000-0000-4000-8000-000000000951', '00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000941', '2026-09-03T10:00:00Z'),
      ('00000000-0000-4000-8000-000000000972', '${workspaceA}', '00000000-0000-4000-8000-000000000951', '00000000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-000000000941', '2026-09-04T10:00:00Z');

    SELECT set_config('app.workspace_id', '${workspaceB}', false);
    INSERT INTO memberships (workspace_id, user_id, role) VALUES
      ('${workspaceB}', '00000000-0000-4000-8000-000000000912', 'owner');
    INSERT INTO media_objects (workspace_id, storage_key, sha256, mime_type, byte_size, state) VALUES
      ('${workspaceB}', 'b-ready', 'sha-c', 'image/png', 700, 'ready');
    RESET app.workspace_id;
    SET ROLE publish_relay_app;
  `);
});

afterEach(async () => database.close());

describe('workspace usage facts PostgreSQL contract', () => {
  it('uses forced RLS, counts target rows independently from accounts, and excludes inactive connections', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const [factsA, factsB] = await Promise.all([
      getWorkspaceUsageFacts(db, { workspaceId: workspaceA }),
      getWorkspaceUsageFacts(db, { workspaceId: workspaceB }),
    ]);

    expect(factsA).toMatchObject({
      media: { retainedBytes: 100, countsByState: { temporary: 0, ready: 1, deleted: 1 } },
      connectedProviderAccounts: 1,
      distinctProviderFamilies: 1,
      existingPublicationTargets: 2,
      queuedOrScheduledTargets: 2,
      workspaceMembers: 1,
    });
    expect(factsB).toMatchObject({
      media: { retainedBytes: 700, countsByState: { temporary: 0, ready: 1, deleted: 0 } },
      connectedProviderAccounts: 0,
      distinctProviderFamilies: 0,
      existingPublicationTargets: 0,
      queuedOrScheduledTargets: 0,
      workspaceMembers: 1,
    });
  });

  it('returns a coherent snapshot while a lifecycle mutation runs concurrently', async () => {
    const db = drizzle(database) as unknown as NodePgDatabase;
    const [facts] = await Promise.all([
      getWorkspaceUsageFacts(db, { workspaceId: workspaceA }),
      database.exec(`
        RESET ROLE;
        SELECT set_config('app.workspace_id', '${workspaceA}', false);
        UPDATE media_objects SET state = 'deleted' WHERE storage_key = 'a-ready';
        SET ROLE publish_relay_app;
      `),
    ]);

    const coherentBefore =
      facts.media.retainedBytes === 100 && facts.media.countsByState.ready === 1;
    const coherentAfter = facts.media.retainedBytes === 0 && facts.media.countsByState.ready === 0;
    expect(coherentBefore || coherentAfter).toBe(true);
    expect(facts.media.countsByState.deleted).toBe(coherentBefore ? 1 : 2);
  });
});
