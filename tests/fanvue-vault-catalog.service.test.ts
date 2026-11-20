import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { FanvueReadService } from '../src/modules/providers/fanvue-read.service.js';
import {
  FanvueVaultCatalogService,
  FanvueVaultPriceConflictError,
} from '../src/modules/providers/fanvue-vault-catalog.service.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const mediaUuid = '00000000-0000-4000-8000-000000000003';
let postgres: PGlite;
let service: FanvueVaultCatalogService;
let reads: {
  listVaultFolderMedia: ReturnType<typeof vi.fn>;
  getMediaStatus: ReturnType<typeof vi.fn>;
};

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
  await postgres.query('INSERT INTO provider_accounts (id, workspace_id) VALUES ($1, $2)', [
    accountId,
    workspaceId,
  ]);
  reads = {
    listVaultFolderMedia: vi.fn().mockResolvedValue({
      data: [{ uuid: mediaUuid, status: 'ready', name: 'Portrait', mediaType: 'image' }],
      pagination: { page: 1, size: 1, hasMore: false },
    }),
    getMediaStatus: vi.fn().mockResolvedValue({ uuid: mediaUuid, status: 'ready' }),
  };
  service = new FanvueVaultCatalogService(
    drizzle(postgres) as unknown as NodePgDatabase,
    reads as unknown as FanvueReadService,
  );
});

afterEach(async () => postgres.close());

it('joins Relay-owned price truth onto live media without caching provider metadata', async () => {
  await expect(
    service.listFolderMedia({ workspaceId, accountId, folderName: 'Paid DMs' }),
  ).resolves.toMatchObject({
    data: [{ uuid: mediaUuid, name: 'Portrait', manualPriceCents: null, priceVersion: null }],
  });
  const saved = await service.savePrice({
    workspaceId,
    accountId,
    providerMediaUuid: mediaUuid,
    manualPriceCents: 350,
    expectedVersion: null,
  });
  expect(saved).toMatchObject({ manualPriceCents: 350, version: 1 });
  await expect(
    service.listFolderMedia({ workspaceId, accountId, folderName: 'Paid DMs' }),
  ).resolves.toMatchObject({
    data: [{ uuid: mediaUuid, manualPriceCents: 350, priceVersion: 1 }],
  });
});

it('requires positive cents and rejects stale optimistic writes', async () => {
  await expect(
    service.savePrice({
      workspaceId,
      accountId,
      providerMediaUuid: mediaUuid,
      manualPriceCents: 0,
      expectedVersion: null,
    }),
  ).rejects.toThrow();
  await service.savePrice({
    workspaceId,
    accountId,
    providerMediaUuid: mediaUuid,
    manualPriceCents: 350,
    expectedVersion: null,
  });
  await expect(
    service.savePrice({
      workspaceId,
      accountId,
      providerMediaUuid: mediaUuid,
      manualPriceCents: null,
      expectedVersion: 2,
    }),
  ).rejects.toBeInstanceOf(FanvueVaultPriceConflictError);
});
