import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const baselineMigrations = [
  '0000_identity_tenancy.sql',
  '0001_solid_spiral.sql',
  '0002_busy_mantis.sql',
  '0003_many_marvel_boy.sql',
  '0004_easy_doctor_spectrum.sql',
  '0005_round_thunderball.sql',
  '0006_enforce_content_workspace_foreign_keys.sql',
  '0007_add_scheduler_attempt_ledger.sql',
  '0008_handy_shen.sql',
  '0009_generalize_oauth_transaction_secret.sql',
  '0016_common_barracuda.sql',
  '0025_lucky_legion.sql',
  '0019_media_retention_lifecycle.sql',
] as const;
const migrationUrl = new URL('../migrations/0037_meta_destination_foundation.sql', import.meta.url);

async function apply(database: PGlite, migration: string): Promise<void> {
  await database.exec(
    await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'),
  );
}

describe('destination foundation migration', () => {
  it('backfills real X/YouTube rows, preserves tenant constraints, and rolls back atomically', async () => {
    const database = new PGlite();
    try {
      for (const migration of baselineMigrations) await apply(database, migration);
      await database.exec(`
        INSERT INTO workspaces (id, name, slug) VALUES
          ('00000000-0000-4000-8000-000000000101', 'One', 'one'),
          ('00000000-0000-4000-8000-000000000201', 'Two', 'two');
        INSERT INTO credentials (id, workspace_id, key_version, wrapped_key, wrapped_key_nonce,
          wrapped_key_tag, ciphertext, nonce, tag) VALUES
          ('00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000101', 'v1', 'a', 'b', 'c', 'd', 'e', 'f'),
          ('00000000-0000-4000-8000-000000000211', '00000000-0000-4000-8000-000000000201', 'v1', 'a', 'b', 'c', 'd', 'e', 'f');
        INSERT INTO provider_connections (id, workspace_id, provider, credential_id) VALUES
          ('00000000-0000-4000-8000-000000000121', '00000000-0000-4000-8000-000000000101', 'x', '00000000-0000-4000-8000-000000000111'),
          ('00000000-0000-4000-8000-000000000122', '00000000-0000-4000-8000-000000000101', 'youtube', '00000000-0000-4000-8000-000000000111');
        INSERT INTO provider_accounts (id, workspace_id, connection_id, provider_account_id, display_name) VALUES
          ('00000000-0000-4000-8000-000000000131', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000121', 'x-remote', 'X'),
          ('00000000-0000-4000-8000-000000000132', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000122', 'yt-remote', 'YouTube');
        BEGIN;
      `);
      await database.exec(await readFile(migrationUrl, 'utf8'));
      const rows = await database.query<{
        provider_account_id: string;
        destination_provider: string;
        remote_account_id: string;
      }>(
        'select provider_account_id, destination_provider, remote_account_id from provider_accounts order by provider_account_id',
      );
      expect(rows.rows).toEqual([
        {
          provider_account_id: 'x-remote',
          destination_provider: 'x',
          remote_account_id: 'x-remote',
        },
        {
          provider_account_id: 'yt-remote',
          destination_provider: 'youtube',
          remote_account_id: 'yt-remote',
        },
      ]);
      await expect(
        database.exec(`UPDATE provider_accounts
          SET credential_id = '00000000-0000-4000-8000-000000000211'
          WHERE id = '00000000-0000-4000-8000-000000000131'`),
      ).rejects.toThrow();
      await database.exec('ROLLBACK');
      const columns = await database.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'provider_accounts' AND column_name = 'destination_provider'
      `);
      expect(columns.rows).toEqual([]);
    } finally {
      await database.close();
    }
  });
});
