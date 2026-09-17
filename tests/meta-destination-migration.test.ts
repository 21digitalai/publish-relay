import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('../migrations/0045_meta_destination_foundation.sql', import.meta.url);

describe('destination foundation migration', () => {
  it('backfills only explicit X and YouTube destinations before enforcing identity', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain("connection.\"provider\" IN ('x', 'youtube')");
    expect(sql).toContain('ALTER COLUMN "destination_provider" SET NOT NULL');
    expect(sql).toContain('ALTER COLUMN "remote_account_id" SET NOT NULL');
  });

  it('preserves tenant-scoped destination and credential relationships', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('provider_accounts_workspace_connection_fk');
    expect(sql).toContain('provider_accounts_workspace_credential_fk');
    expect(sql).toContain('provider_accounts_connection_destination_remote_unique');
  });
});
