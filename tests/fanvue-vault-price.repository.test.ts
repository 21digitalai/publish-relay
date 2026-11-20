import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  listFanvueVaultMediaPrices,
  saveFanvueVaultMediaPrice,
} from '../src/modules/providers/fanvue-vault-price.repository.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const otherAccountId = '00000000-0000-4000-8000-000000000003';
const mediaUuid = '00000000-0000-4000-8000-000000000004';
let postgres: PGlite;
let database: NodePgDatabase;

beforeEach(async () => {
  postgres = new PGlite();
  await postgres.exec(`
    CREATE TABLE provider_accounts (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL,
      UNIQUE(workspace_id, id)
    );
  `);
  await postgres.exec(
    await readFile(
      new URL('../migrations/0125_fanvue_vault_media_prices.sql', import.meta.url),
      'utf8',
    ),
  );
  await postgres.query(
    'INSERT INTO provider_accounts (id, workspace_id) VALUES ($1, $2), ($3, $2)',
    [accountId, workspaceId, otherAccountId],
  );
  database = drizzle(postgres) as unknown as NodePgDatabase;
});

afterEach(async () => postgres.close());

it('saves, conflicts, clears, and lists price truth by account and media UUID', async () => {
  const now = new Date('2026-11-20T11:00:00Z');
  const created = await saveFanvueVaultMediaPrice(database, {
    workspaceId,
    accountId,
    providerMediaUuid: mediaUuid,
    manualPriceCents: 350,
    expectedVersion: null,
    now,
  });
  expect(created).toMatchObject({ manualPriceCents: 350, version: 1 });

  await expect(
    saveFanvueVaultMediaPrice(database, {
      workspaceId,
      accountId,
      providerMediaUuid: mediaUuid,
      manualPriceCents: 400,
      expectedVersion: null,
      now,
    }),
  ).resolves.toBeNull();

  const cleared = await saveFanvueVaultMediaPrice(database, {
    workspaceId,
    accountId,
    providerMediaUuid: mediaUuid,
    manualPriceCents: null,
    expectedVersion: 1,
    now: new Date('2026-11-20T11:01:00Z'),
  });
  expect(cleared).toMatchObject({ manualPriceCents: null, version: 2 });
  await expect(
    listFanvueVaultMediaPrices(database, {
      workspaceId,
      accountId,
      providerMediaUuids: [mediaUuid],
    }),
  ).resolves.toEqual([cleared]);
  await expect(
    listFanvueVaultMediaPrices(database, {
      workspaceId,
      accountId: otherAccountId,
      providerMediaUuids: [mediaUuid],
    }),
  ).resolves.toEqual([]);
});

it('rejects zero while retaining blank-as-unset', async () => {
  await expect(
    saveFanvueVaultMediaPrice(database, {
      workspaceId,
      accountId,
      providerMediaUuid: mediaUuid,
      manualPriceCents: 0,
      expectedVersion: null,
      now: new Date(),
    }),
  ).rejects.toThrow();
});
