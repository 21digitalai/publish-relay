import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('../migrations/0034_simple_jamie_braddock.sql', import.meta.url);

describe('external draft migration contract', () => {
  it('creates tenant-scoped drafts and ordered media attachments', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('CREATE TABLE "external_drafts"');
    expect(sql).toContain('CREATE TABLE "external_draft_media"');
    expect(sql).toContain('"source_actor_type" "audit_actor_type" NOT NULL');
    expect(sql).toContain('"external_id" text NOT NULL');
    expect(sql).toContain('external_drafts_source_external_unique');
    expect(sql).toContain('external_draft_media_position_unique');
    expect(sql).toContain('external_draft_media_workspace_media_fk');
    expect(sql.indexOf('external_drafts_workspace_id_unique')).toBeLessThan(
      sql.indexOf('external_draft_media_workspace_draft_fk'),
    );
  });

  it('forces workspace isolation on both new tables', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain("ARRAY['external_drafts','external_draft_media']");
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('WITH CHECK (workspace_id =');
  });
});
