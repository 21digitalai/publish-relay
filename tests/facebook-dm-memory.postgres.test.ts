import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import {
  getPageDmMemoryMany,
  terminalPageConversationIds,
  upsertPageDmMemory,
} from '../src/modules/providers/facebook-dm-memory.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const otherAccountId = '00000000-0000-4000-8000-000000000003';

describe('Page DM working memory', () => {
  it('keeps compact facts Page-local and supports batched missing and terminal filtering', async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`
        CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL,
          destination_provider text NOT NULL, PRIMARY KEY (workspace_id, id));
        INSERT INTO provider_accounts VALUES
          ('${accountId}', '${workspaceId}', 'facebook_page'),
          ('${otherAccountId}', '${workspaceId}', 'facebook_page');
      `);
      await pg.exec(
        await readFile(
          new URL('../migrations/0103_facebook_page_dm_memory.sql', import.meta.url),
          'utf8',
        ),
      );
      await pg.exec(
        'CREATE TABLE facebook_page_dm_actions (id uuid PRIMARY KEY); CREATE TABLE facebook_page_dm_pending_intents (id uuid PRIMARY KEY); CREATE TABLE facebook_page_dm_no_go (id uuid PRIMARY KEY);',
      );
      await pg.exec(
        await readFile(
          new URL('../migrations/0118_facebook_dm_final_exit_receipt.sql', import.meta.url),
          'utf8',
        ),
      );
      const database = drizzle(pg) as unknown as NodePgDatabase;
      const key = { workspaceId, accountId };
      const firstContactAt = new Date('2026-11-01T00:00:00Z');
      await upsertPageDmMemory(database, {
        ...key,
        conversationId: 't_1',
        patch: {
          facts: ['Prefers morning messages'],
          firstContactAt,
          terminal: true,
          lastProcessedInboundId: 'mid_1',
        },
      });
      await upsertPageDmMemory(database, {
        ...key,
        conversationId: 't_1',
        patch: {
          lastOutboundReceiptRef: 'receipt_1',
          unansweredFollowUp: true,
        },
      });
      await upsertPageDmMemory(database, {
        ...key,
        conversationId: 't_1',
        patch: {
          lastOutboundReceiptRef: 'receipt_1',
          unansweredFollowUp: true,
        },
      });
      const records = await getPageDmMemoryMany(database, {
        ...key,
        conversationIds: ['t_1', 't_missing'],
      });
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        facts: ['Prefers morning messages'],
        firstContactAt,
        lastProcessedInboundId: 'mid_1',
        lastOutboundReceiptRef: 'receipt_1',
        terminal: true,
        unansweredFollowUp: true,
      });
      expect(records[0]?.conversationAgeDays).toBeGreaterThanOrEqual(0);
      expect(records[1]).toMatchObject({
        conversationId: 't_missing',
        facts: [],
        terminal: false,
        conversationAgeDays: null,
      });
      expect(
        await getPageDmMemoryMany(database, {
          ...key,
          conversationIds: ['t_1', 't_missing'],
          terminal: 'exclude',
        }),
      ).toHaveLength(1);
      expect(
        await getPageDmMemoryMany(database, {
          ...key,
          conversationIds: ['t_1', 't_missing'],
          terminal: 'only',
        }),
      ).toHaveLength(1);
      expect(
        await getPageDmMemoryMany(database, {
          workspaceId,
          accountId: otherAccountId,
          conversationIds: ['t_1'],
        }),
      ).toMatchObject([{ facts: [] }]);
      expect(JSON.stringify(records)).not.toMatch(/providerToken|messageText|accessToken/);
      expect(
        await terminalPageConversationIds(database, {
          ...key,
          conversationIds: ['t_1', 't_missing'],
        }),
      ).toEqual(new Set(['t_1']));
      expect(
        await terminalPageConversationIds(database, {
          workspaceId,
          accountId: otherAccountId,
          conversationIds: ['t_1'],
        }),
      ).toEqual(new Set());
    } finally {
      await pg.close();
    }
  });
});
