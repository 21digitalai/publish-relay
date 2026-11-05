import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import {
  isPageConversationNoGo,
  listPageNoGo,
  setPageConversationNoGo,
} from '../src/modules/providers/facebook-dm-no-go.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const otherAccountId = '00000000-0000-4000-8000-000000000003';
const key = { workspaceId, accountId, conversationId: 't_123' };

describe('Page DM no-go list', () => {
  it('isolates Page accounts, dismisses pending replies, and permits an explicit unblock', async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`
        CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL,
          destination_provider text NOT NULL, PRIMARY KEY (workspace_id, id));
        CREATE TABLE engagement_proposals (id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
          account_id uuid NOT NULL, provider text NOT NULL, kind text NOT NULL,
          target_id text NOT NULL, status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
        INSERT INTO provider_accounts VALUES
          ('${accountId}', '${workspaceId}', 'facebook_page'),
          ('${otherAccountId}', '${workspaceId}', 'facebook_page');
        INSERT INTO engagement_proposals (id, workspace_id, account_id, provider, kind, target_id, status) VALUES
          ('00000000-0000-4000-8000-000000000004', '${workspaceId}', '${accountId}', 'facebook_page', 'dm', 't_123', 'pending'),
          ('00000000-0000-4000-8000-000000000005', '${workspaceId}', '${otherAccountId}', 'facebook_page', 'dm', 't_123', 'pending');
      `);
      await pg.exec(
        await readFile(
          new URL('../migrations/0095_facebook_page_dm_no_go.sql', import.meta.url),
          'utf8',
        ),
      );
      const db = drizzle(pg) as unknown as NodePgDatabase;
      await setPageConversationNoGo(db, { ...key, blocked: true, displayName: 'Alexandra' });
      expect(await isPageConversationNoGo(db, key)).toBe(true);
      expect(await isPageConversationNoGo(db, { ...key, accountId: otherAccountId })).toBe(false);
      expect(await listPageNoGo(db, { workspaceId, accountId })).toMatchObject([
        { displayName: 'Alexandra' },
      ]);
      const statuses = await pg.query(
        'SELECT account_id, status FROM engagement_proposals ORDER BY account_id',
      );
      expect(statuses.rows).toMatchObject([{ status: 'dismissed' }, { status: 'pending' }]);
      await setPageConversationNoGo(db, { ...key, blocked: false });
      expect(await isPageConversationNoGo(db, key)).toBe(false);
    } finally {
      await pg.close();
    }
  });
});
