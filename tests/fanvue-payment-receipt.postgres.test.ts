import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { ApiRateLimiter } from '../src/modules/api/rate-limit.js';
import {
  ApiKeyAuthorizationError,
  type ApiKeyService,
} from '../src/modules/identity/api-key.service.js';
import type { FanvuePaymentSignal } from '../src/modules/providers/fanvue-payment-event.js';
import { receiptFanvuePaymentForAccount } from '../src/modules/providers/fanvue-payment-receipt.repository.js';
import { registerFanvuePaymentRoutes } from '../src/modules/providers/fanvue-payment.routes.js';

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

it('serves bounded account-scoped payment facts only with the read capability', async () => {
  await receiptFanvuePaymentForAccount(database, { workspaceId, accountId, signal });
  const app = Fastify();
  registerFanvuePaymentRoutes(app, {
    database,
    apiKeys: {
      authenticate: (selectedWorkspace: string, token: string) =>
        Promise.resolve({
          id: accountId,
          workspaceId: selectedWorkspace,
          capabilities: token === 'read-key' ? ['fanvue:payments:read'] : [],
        }),
      requireCapability: (principal: { capabilities: string[] }, capability: string) =>
        principal.capabilities.includes(capability)
          ? Promise.resolve()
          : Promise.reject(new ApiKeyAuthorizationError('missing capability')),
    } as unknown as ApiKeyService,
    rateLimiter: new ApiRateLimiter({
      workspace: 100,
      key: 100,
      mutationWorkspace: 10,
      mutationKey: 10,
      windowMs: 60000,
    }),
  });
  const url = `/api/v1/fanvue/accounts/${accountId}/payment-signals`;
  const headers = { authorization: 'Bearer read-key', 'x-publish-relay-workspace': workspaceId };
  const response = await app.inject({ method: 'GET', url, headers });
  expect(response.statusCode).toBe(200);
  expect(
    response.json<{
      data: { items: { source: string; tipContext: string | null; messageUuid: string | null }[] };
    }>().data.items,
  ).toMatchObject([{ source: 'tip', tipContext: 'message', messageUuid: null }]);
  expect(response.body).not.toMatch(
    /eventFingerprint|creatorUuid|accountId|workspaceId|email|offer/,
  );
  expect(Buffer.byteLength(response.body)).toBeLessThan(700);
  await postgres.query(`
    INSERT INTO fanvue_payment_receipts
      (workspace_id, account_id, event_id, event_fingerprint, creator_uuid, fan_uuid,
       invoice_id, source, gross_minor, currency, event_at)
    SELECT '${workspaceId}', '${accountId}',
      ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
      'fixture', '${creatorUuid}', '${signal.fanUuid}', 'FV-' || i,
      'tip', 500, 'USD', '2026-10-25T11:00:00Z'::timestamptz + i * interval '1 microsecond'
    FROM generate_series(100, 150) AS i
  `);
  const firstPage = (await app.inject({ method: 'GET', url, headers })).json<{
    data: { items: { eventId: string }[]; nextCursor: string | null };
  }>().data;
  expect(firstPage.items).toHaveLength(50);
  expect(firstPage.nextCursor).toBeTruthy();
  const secondPage = (
    await app.inject({ method: 'GET', url: `${url}?cursor=${firstPage.nextCursor ?? ''}`, headers })
  ).json<{
    data: { items: { eventId: string }[]; nextCursor: string | null };
  }>().data;
  expect(secondPage.items).toHaveLength(2);
  expect(secondPage.nextCursor).toBeNull();
  expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.eventId)).size).toBe(
    52,
  );
  expect(
    (
      await app.inject({
        method: 'GET',
        url,
        headers: { ...headers, authorization: 'Bearer blocked-key' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'GET',
        url,
        headers: { ...headers, 'x-publish-relay-workspace': otherWorkspaceId },
      })
    ).json<{ data: { items: unknown[] } }>().data.items,
  ).toEqual([]);
  expect((await app.inject({ method: 'GET', url: `${url}?cursor=bad`, headers })).statusCode).toBe(
    400,
  );
  await app.close();
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
