import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, expect, it } from 'vitest';

import type { FanvuePaymentSignal } from '../src/modules/providers/fanvue-payment-event.js';
import { receiptFanvuePaymentForAccount } from '../src/modules/providers/fanvue-payment-receipt.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const otherWorkspaceId = '00000000-0000-4000-8000-000000000002';
const accountId = '00000000-0000-4000-8000-000000000003';
const connectionId = '00000000-0000-4000-8000-000000000004';
const creatorUuid = '00000000-0000-4000-8000-000000000005';
const signal: FanvuePaymentSignal = {
  eventId: '00000000-0000-4000-8000-000000000006',
  creatorUuid,
  fanUuid: '00000000-0000-4000-8000-000000000007',
  invoiceId: 'FV-123',
  source: 'tip',
  grossMinor: 500,
  currency: 'USD',
  paidAt: '2026-10-25T10:00:00Z',
  eventAt: '2026-10-25T10:00:01Z',
  postUuid: null,
  messageUuid: null,
  tipContext: 'message',
};
let postgres: PGlite;
let database: NodePgDatabase;

beforeEach(async () => {
  postgres = new PGlite();
  await postgres.exec(`
    CREATE TABLE provider_connections (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, provider text NOT NULL,
      external_subject_id text NOT NULL, status text NOT NULL
    );
    CREATE TABLE provider_accounts (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL, connection_id uuid NOT NULL,
      destination_provider text NOT NULL, remote_account_id text NOT NULL,
      availability text NOT NULL, UNIQUE(workspace_id, id)
    );
  `);
  await postgres.exec(
    await readFile(
      new URL('../migrations/0080_fanvue_payment_receipts.sql', import.meta.url),
      'utf8',
    ),
  );
  await postgres.query(`INSERT INTO provider_connections VALUES ($1,$2,'fanvue',$3,'active')`, [
    connectionId,
    workspaceId,
    creatorUuid,
  ]);
  await postgres.query(`INSERT INTO provider_accounts VALUES ($1,$2,$3,'fanvue',$4,'active')`, [
    accountId,
    workspaceId,
    connectionId,
    creatorUuid,
  ]);
  database = drizzle(postgres) as unknown as NodePgDatabase;
});

afterEach(async () => postgres.close());

it('records signed facts once without private payload fields or offer inference', async () => {
  const input = { workspaceId, accountId, signal };
  await expect(receiptFanvuePaymentForAccount(database, input)).resolves.toBe('recorded');
  await expect(receiptFanvuePaymentForAccount(database, input)).resolves.toBe('duplicate');
  const stored = await postgres.query<{
    source: string;
    message_uuid: string | null;
    tip_context: string;
  }>('SELECT source, message_uuid, tip_context FROM fanvue_payment_receipts');
  expect(stored.rows).toEqual([{ source: 'tip', message_uuid: null, tip_context: 'message' }]);
  expect(Object.keys(stored.rows[0] ?? {})).not.toContain('email');
  await expect(
    receiptFanvuePaymentForAccount(database, {
      ...input,
      signal: { ...signal, grossMinor: 600 },
    }),
  ).rejects.toThrow('conflicts');
});

it('denies foreign workspace or creator and unavailable connection before receipt', async () => {
  await expect(
    receiptFanvuePaymentForAccount(database, { workspaceId: otherWorkspaceId, accountId, signal }),
  ).rejects.toThrow('unavailable');
  await expect(
    receiptFanvuePaymentForAccount(database, {
      workspaceId,
      accountId,
      signal: { ...signal, creatorUuid: otherWorkspaceId },
    }),
  ).rejects.toThrow('unavailable');
  await postgres.query("UPDATE provider_connections SET status='reconnect_required'");
  await expect(
    receiptFanvuePaymentForAccount(database, { workspaceId, accountId, signal }),
  ).rejects.toThrow('unavailable');
  const count = await postgres.query<{ count: number }>(
    'SELECT count(*) FROM fanvue_payment_receipts',
  );
  expect(count.rows[0]?.count).toBe(0);
});
