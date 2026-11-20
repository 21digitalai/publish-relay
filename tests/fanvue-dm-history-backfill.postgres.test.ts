import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import { backfillFanvueDmHistory } from '../src/modules/providers/fanvue-dm-history-backfill.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000002';
const accountId = '00000000-0000-4000-8000-000000000003';
const fanUuid = '00000000-0000-4000-8000-000000000004';
const creatorUuid = '00000000-0000-4000-8000-000000000099';
const inboundUuid = '00000000-0000-4000-8000-000000000010';
const manualGiftUuid = '00000000-0000-4000-8000-000000000011';
const paidUuid = '00000000-0000-4000-8000-000000000012';
const mediaUuid = '00000000-0000-4000-8000-000000000020';

async function setup() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE provider_accounts (id uuid NOT NULL, workspace_id uuid NOT NULL,
      destination_provider text NOT NULL, PRIMARY KEY (workspace_id,id));
    CREATE TABLE fanvue_action_intents (
      workspace_id uuid NOT NULL, account_id uuid NOT NULL, client_action_id uuid NOT NULL,
      target_uuid uuid NOT NULL, provider_object_uuid uuid);
    CREATE TABLE fanvue_dm_pending_intents (
      workspace_id uuid NOT NULL, account_id uuid NOT NULL, client_action_id uuid NOT NULL,
      group_id uuid, sequence_index integer);
    INSERT INTO provider_accounts VALUES ('${accountId}','${workspaceId}','fanvue'),
      ('${accountId}','${otherWorkspaceId}','fanvue');
  `);
  for (const migration of [
    '0127_fanvue_dm_conversation_facts.sql',
    '0128_fanvue_dm_receipt_exchange_roles.sql',
    '0129_fanvue_dm_history_backfill_state.sql',
  ])
    await pg.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  return { pg, database: drizzle(pg) as unknown as NodePgDatabase };
}

function message(
  uuid: string,
  direction: 'inbound' | 'outbound',
  sentAt: string,
  mediaUuids: string[] = [],
) {
  const inbound = direction === 'inbound';
  return {
    uuid,
    text: null,
    sentAt,
    sender: { uuid: inbound ? fanUuid : creatorUuid, handle: null },
    recipient: { uuid: inbound ? creatorUuid : fanUuid, handle: null },
    type: 'message',
    mediaUuids,
    mediaPreviewUuid: null,
    pricing: uuid === paidUuid ? { USD: { price: 500 } } : null,
    purchasedAt: uuid === paidUuid ? '2026-11-20T10:30:00.000Z' : null,
    tipSource: null,
    isRead: true,
  };
}

function page(data: ReturnType<typeof message>[], pageNumber: number, hasMore: boolean) {
  return { data, pagination: { page: pageNumber, size: data.length, hasMore } } as never;
}

describe('Fanvue DM history backfill', () => {
  it('restarts after failure, deduplicates overlap and excludes the explicit manual gift', async () => {
    const { pg, database } = await setup();
    try {
      const firstPage = page(
        [
          message(manualGiftUuid, 'outbound', '2026-11-20T10:05:00.000Z', [mediaUuid]),
          message(inboundUuid, 'inbound', '2026-11-20T10:00:00.000Z'),
        ],
        1,
        true,
      );
      const incomplete = await backfillFanvueDmHistory(
        database,
        { workspaceId, accountId, fanUuid, excludeMediaForMessageUuids: [manualGiftUuid] },
        (requestedPage) =>
          requestedPage === 1
            ? Promise.resolve(firstPage)
            : Promise.reject(new Error('provider unavailable')),
      );
      expect(incomplete).toMatchObject({ state: 'incomplete', reason: 'provider_read_failed' });
      const partial = await pg.query<{
        history_backfill_status: string;
        history_coverage_oldest_at: Date;
        history_backfill_complete_at: Date | null;
      }>(`SELECT history_backfill_status, history_coverage_oldest_at,
          history_backfill_complete_at FROM fanvue_dm_conversation_state`);
      expect(partial.rows[0]).toEqual({
        history_backfill_status: 'incomplete',
        history_coverage_oldest_at: new Date('2026-11-20T10:00:00.000Z'),
        history_backfill_complete_at: null,
      });

      const complete = await backfillFanvueDmHistory(
        database,
        { workspaceId, accountId, fanUuid, excludeMediaForMessageUuids: [manualGiftUuid] },
        (requestedPage) =>
          requestedPage === 1
            ? Promise.resolve(firstPage)
            : Promise.resolve(
                page(
                  [
                    message(inboundUuid, 'inbound', '2026-11-20T10:00:00.000Z'),
                    message(paidUuid, 'outbound', '2026-11-20T10:20:00.000Z', [mediaUuid]),
                  ],
                  2,
                  false,
                ),
              ),
      );
      expect(complete).toMatchObject({ state: 'complete', pagesIngested: 2, messagesIngested: 4 });
      const receipts = await pg.query<{ uuid: string; role: string }>(
        `SELECT provider_message_uuid AS uuid, exchange_role AS role
           FROM fanvue_dm_message_receipts ORDER BY sent_at`,
      );
      expect(receipts.rows).toEqual([
        { uuid: inboundUuid, role: 'inbound_turn' },
        { uuid: manualGiftUuid, role: 'automation' },
        { uuid: paidUuid, role: 'automation' },
      ]);
      const media = await pg.query<{ provider_message_uuid: string; price_cents: number }>(
        'SELECT provider_message_uuid, price_cents FROM fanvue_dm_media_deliveries',
      );
      expect(media.rows).toEqual([{ provider_message_uuid: paidUuid, price_cents: 500 }]);
    } finally {
      await pg.close();
    }
  });

  it('marks invalid direction incomplete without leaking rows across tenants', async () => {
    const { pg, database } = await setup();
    try {
      const invalid = message(inboundUuid, 'inbound', '2026-11-20T10:00:00.000Z');
      invalid.sender.uuid = creatorUuid;
      invalid.recipient.uuid = creatorUuid;
      await expect(
        backfillFanvueDmHistory(database, { workspaceId, accountId, fanUuid }, () =>
          Promise.resolve(page([invalid], 1, false)),
        ),
      ).resolves.toMatchObject({ state: 'incomplete', reason: 'invalid_message_direction' });
      expect((await pg.query('SELECT * FROM fanvue_dm_message_receipts')).rows).toHaveLength(0);
      expect(
        await backfillFanvueDmHistory(
          database,
          { workspaceId: otherWorkspaceId, accountId, fanUuid },
          () =>
            Promise.resolve(
              page([message(inboundUuid, 'inbound', '2026-11-20T10:00:00.000Z')], 1, false),
            ),
        ),
      ).toMatchObject({ state: 'complete' });
      const counts = await pg.query<{ workspace_id: string; count: number }>(
        `SELECT workspace_id, count(*)::integer AS count FROM fanvue_dm_message_receipts
         GROUP BY workspace_id`,
      );
      expect(counts.rows).toEqual([{ workspace_id: otherWorkspaceId, count: 1 }]);
    } finally {
      await pg.close();
    }
  });
});
