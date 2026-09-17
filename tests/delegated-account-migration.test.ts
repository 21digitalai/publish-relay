import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('../migrations/0035_delegated_account_receipt.sql', import.meta.url);

describe('delegated account receipt migration', () => {
  it('projects only the active token connection receipt through the audited resolver', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('workspace_label text');
    expect(sql).toContain('access_expires_at timestamptz');
    expect(sql).toContain('workspace_record.id = token.workspace_id');
    expect(sql).toContain('token.access_token_hash = requested_access_hash');
    expect(sql).toContain('grant_record.revoked_at IS NULL');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.resolve_delegated_access_token');
    expect(sql).not.toContain('access_token_hash text');
    expect(sql).not.toContain('refresh_token_hash text');
  });
});
