import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import {
  FanvueDmMessageReceiptConflictError,
  listDueFanvueDmConversations,
  observeFanvueDmConversationSummary,
  recordFanvueDmMessageReceipt,
  updateFanvueDmConversationWorkflow,
} from '../src/modules/providers/fanvue-dm-conversation-state.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000002';
const accountId = '00000000-0000-4000-8000-000000000003';
const fanUuid = '00000000-0000-4000-8000-000000000004';
const firstInbound = '00000000-0000-4000-8000-000000000005';
const secondInbound = '00000000-0000-4000-8000-000000000006';

async function setup() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL,
      destination_provider text NOT NULL, PRIMARY KEY (workspace_id,id));
    INSERT INTO provider_accounts VALUES ('${accountId}','${workspaceId}','fanvue'),
      ('${accountId}','${otherWorkspaceId}','fanvue');
  `);
  await pg.exec(
    await readFile(
      new URL('../migrations/0127_fanvue_dm_conversation_facts.sql', import.meta.url),
      'utf8',
    ),
  );
  return { pg, database: drizzle(pg) as unknown as NodePgDatabase };
}

describe('Fanvue neutral conversation state', () => {
  it('deduplicates provider receipts and advances boundaries monotonically', async () => {
    const { pg, database } = await setup();
    try {
      const base = {
        workspaceId,
        accountId,
        fanUuid,
        providerMessageUuid: firstInbound,
        direction: 'inbound' as const,
        sentAt: new Date('2026-11-20T10:00:00Z'),
        mediaUuids: ['00000000-0000-4000-8000-000000000010'],
        priceCents: null,
        purchasedAt: null,
        observedAt: new Date('2026-11-20T10:01:00Z'),
      };
      await recordFanvueDmMessageReceipt(database, base);
      await recordFanvueDmMessageReceipt(database, {
        ...base,
        mediaUuids: ['00000000-0000-4000-8000-000000000010'],
        observedAt: new Date('2026-11-20T10:02:00Z'),
      });
      await recordFanvueDmMessageReceipt(database, {
        ...base,
        providerMessageUuid: secondInbound,
        sentAt: new Date('2026-11-20T10:10:00Z'),
        mediaUuids: [],
        observedAt: new Date('2026-11-20T10:11:00Z'),
      });
      await recordFanvueDmMessageReceipt(database, {
        ...base,
        observedAt: new Date('2026-11-20T10:12:00Z'),
      });
      await expect(
        recordFanvueDmMessageReceipt(database, {
          ...base,
          fanUuid: '00000000-0000-4000-8000-000000000020',
          observedAt: new Date('2026-11-20T10:13:00Z'),
        }),
      ).rejects.toBeInstanceOf(FanvueDmMessageReceiptConflictError);
      await recordFanvueDmMessageReceipt(database, {
        ...base,
        workspaceId: otherWorkspaceId,
        observedAt: new Date('2026-11-20T10:14:00Z'),
      });
      const receipts = await pg.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM fanvue_dm_message_receipts',
      );
      expect(receipts.rows[0]?.count).toBe(3);
      const state = await pg.query<{ latest_inbound_message_uuid: string }>(
        'SELECT latest_inbound_message_uuid FROM fanvue_dm_conversation_state',
      );
      expect(state.rows[0]?.latest_inbound_message_uuid).toBe(secondInbound);
    } finally {
      await pg.close();
    }
  });

  it('reactivates a quiet conversation only for a changed inbound boundary', async () => {
    const { pg, database } = await setup();
    try {
      const observedAt = new Date('2026-11-20T10:00:00Z');
      const base = { workspaceId, accountId, fanUuid };
      await observeFanvueDmConversationSummary(database, {
        ...base,
        latestMessageUuid: firstInbound,
        latestMessageAt: observedAt,
        latestDirection: 'inbound',
        providerIsRead: false,
        providerUnreadCount: 1,
        observedAt,
      });
      await updateFanvueDmConversationWorkflow(database, {
        ...base,
        quietUntilInboundAfterUuid: firstInbound,
        nextReviewAt: null,
      });
      const readFlagOnly = await observeFanvueDmConversationSummary(database, {
        ...base,
        latestMessageUuid: firstInbound,
        latestMessageAt: observedAt,
        latestDirection: 'inbound',
        providerIsRead: true,
        providerUnreadCount: 0,
        observedAt: new Date('2026-11-20T10:05:00Z'),
      });
      expect(readFlagOnly.quietUntilInboundAfterUuid).toBe(firstInbound);
      const reactivatedAt = new Date('2026-11-20T10:10:00Z');
      const changed = await observeFanvueDmConversationSummary(database, {
        ...base,
        latestMessageUuid: secondInbound,
        latestMessageAt: reactivatedAt,
        latestDirection: 'inbound',
        providerIsRead: false,
        providerUnreadCount: 1,
        observedAt: reactivatedAt,
      });
      expect(changed.quietUntilInboundAfterUuid).toBeNull();
      expect(changed.nextReviewAt).toEqual(reactivatedAt);
    } finally {
      await pg.close();
    }
  });

  it('does not regress or reactivate from stale or ambiguous chat-list summaries', async () => {
    const { pg, database } = await setup();
    try {
      const base = { workspaceId, accountId, fanUuid };
      const firstAt = new Date('2026-11-20T10:00:00Z');
      const secondAt = new Date('2026-11-20T10:10:00Z');
      await observeFanvueDmConversationSummary(database, {
        ...base,
        latestMessageUuid: firstInbound,
        latestMessageAt: firstAt,
        latestDirection: 'inbound',
        providerIsRead: false,
        providerUnreadCount: 1,
        observedAt: firstAt,
      });
      await observeFanvueDmConversationSummary(database, {
        ...base,
        latestMessageUuid: secondInbound,
        latestMessageAt: secondAt,
        latestDirection: 'inbound',
        providerIsRead: true,
        providerUnreadCount: 0,
        observedAt: secondAt,
      });
      await updateFanvueDmConversationWorkflow(database, {
        ...base,
        quietUntilInboundAfterUuid: secondInbound,
        nextReviewAt: null,
      });

      const stale = await observeFanvueDmConversationSummary(database, {
        ...base,
        latestMessageUuid: firstInbound,
        latestMessageAt: firstAt,
        latestDirection: 'inbound',
        providerIsRead: false,
        providerUnreadCount: 8,
        observedAt: new Date('2026-11-20T10:20:00Z'),
      });
      expect(stale).toMatchObject({
        latestObservedMessageUuid: secondInbound,
        latestObservedAt: secondAt,
        latestInboundMessageUuid: secondInbound,
        latestInboundAt: secondAt,
        providerIsRead: true,
        providerUnreadCount: 0,
        quietUntilInboundAfterUuid: secondInbound,
        nextReviewAt: null,
      });

      const ambiguousUuid = '00000000-0000-4000-8000-000000000007';
      const ambiguous = await observeFanvueDmConversationSummary(database, {
        ...base,
        latestMessageUuid: ambiguousUuid,
        latestMessageAt: secondAt,
        latestDirection: 'inbound',
        providerIsRead: false,
        providerUnreadCount: 9,
        observedAt: new Date('2026-11-20T10:25:00Z'),
      });
      expect(ambiguous).toMatchObject({
        latestObservedMessageUuid: secondInbound,
        latestInboundMessageUuid: secondInbound,
        providerIsRead: true,
        providerUnreadCount: 0,
        quietUntilInboundAfterUuid: secondInbound,
        nextReviewAt: null,
      });
    } finally {
      await pg.close();
    }
  });

  it('returns only due non-quiet rows in the selected tenant', async () => {
    const { pg, database } = await setup();
    try {
      const dueAt = new Date('2026-11-20T10:00:00Z');
      await observeFanvueDmConversationSummary(database, {
        workspaceId,
        accountId,
        fanUuid,
        latestMessageUuid: firstInbound,
        latestMessageAt: dueAt,
        latestDirection: 'inbound',
        providerIsRead: false,
        providerUnreadCount: 1,
        observedAt: dueAt,
      });
      expect(
        await listDueFanvueDmConversations(database, {
          workspaceId,
          accountId,
          now: new Date('2026-11-20T10:01:00Z'),
        }),
      ).toMatchObject([{ fanUuid, latestInboundMessageUuid: firstInbound }]);
      expect(
        await listDueFanvueDmConversations(database, {
          workspaceId: otherWorkspaceId,
          accountId,
          now: new Date('2026-11-20T10:01:00Z'),
        }),
      ).toEqual([]);
    } finally {
      await pg.close();
    }
  });
});
