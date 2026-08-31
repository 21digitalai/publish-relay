import { readFile } from 'node:fs/promises';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('../migrations/0000_identity_tenancy.sql', import.meta.url);

describe('identity tenancy migration contract', () => {
  it('creates every foundational table and tenant policy', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    for (const table of ['memberships', 'sessions', 'api_keys', 'audit_events', 'outbox_events']) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('WITH CHECK (workspace_id =');
    expect(sql).toContain('audit_events_append_only');
  });

  it('is readable by the production Drizzle migration runner', () => {
    const migrations = readMigrationFiles({ migrationsFolder: 'migrations' });
    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.sql.length).toBeGreaterThan(0);
  });

  it('never stores raw API key or session secrets', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('"token_hash" text NOT NULL');
    expect(sql).toContain('"secret_hash" text NOT NULL');
    expect(sql).not.toMatch(/api_key[^\n]*secret text/i);
    expect(sql).not.toMatch(/session[^\n]*token text/i);
  });
});
