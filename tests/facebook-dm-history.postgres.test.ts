import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import { listPageDmHistory } from '../src/modules/providers/facebook-dm-history.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000002';
const accountId = '00000000-0000-4000-8000-000000000003';

describe('Page DM history', () => {
  it('merges proposals and send actions while filtering receivers and tenants', async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`
        CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL, display_name text NOT NULL, PRIMARY KEY (workspace_id,id));
        CREATE TABLE engagement_proposals (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, account_id uuid NOT NULL,
          provider text NOT NULL, kind text NOT NULL, target_id text NOT NULL, status text NOT NULL,
          source_context jsonb NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
        CREATE TABLE facebook_page_dm_actions (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, account_id uuid NOT NULL,
          conversation_id text NOT NULL, state text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
        INSERT INTO provider_accounts VALUES ('${accountId}','${workspaceId}','Eli Page'), ('${accountId}','${otherWorkspaceId}','Other Page');
        INSERT INTO engagement_proposals VALUES
          ('00000000-0000-4000-8000-000000000011','${workspaceId}','${accountId}','facebook_page','dm','t_100','pending','{"authorLabel":"Alexandra","text":"private source"}','2026-11-05 09:00Z','2026-11-05 09:00Z'),
          ('00000000-0000-4000-8000-000000000012','${otherWorkspaceId}','${accountId}','facebook_page','dm','t_100','pending','{}','2026-11-05 09:10Z','2026-11-05 09:10Z');
        INSERT INTO facebook_page_dm_actions VALUES
          ('00000000-0000-4000-8000-000000000021','${workspaceId}','${accountId}','t_100','confirmed','2026-11-05 09:05Z','2026-11-05 09:05Z'),
          ('00000000-0000-4000-8000-000000000022','${workspaceId}','${accountId}','t_200','failed','2026-11-05 09:06Z','2026-11-05 09:06Z');
      `);
      const db = drizzle(pg) as unknown as NodePgDatabase;
      const all = await listPageDmHistory(db, { workspaceId, limit: 50 });
      expect(all.map((row) => row.status)).toEqual(['failed', 'confirmed', 'pending']);
      expect(all[2]).toMatchObject({ receiverLabel: 'Alexandra', conversationId: 't_100' });
      expect(JSON.stringify(all)).not.toContain('private source');
      const filtered = await listPageDmHistory(db, {
        workspaceId,
        accountId,
        conversationId: 't_100',
        limit: 50,
      });
      expect(filtered.map((row) => row.kind)).toEqual(['send', 'proposal']);
      const second = all[1];
      if (!second) throw new Error('Expected second history row');
      const before = await listPageDmHistory(db, {
        workspaceId,
        limit: 50,
        beforeCreatedAt: second.createdAt,
        beforeId: second.id,
      });
      expect(before.map((row) => row.kind)).toEqual(['proposal']);
    } finally {
      await pg.close();
    }
  });
});
