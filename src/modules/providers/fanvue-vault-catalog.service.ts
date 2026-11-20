import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { FanvueReadService } from './fanvue-read.service.js';
import {
  listFanvueVaultMediaPrices,
  saveFanvueVaultMediaPrice,
} from './fanvue-vault-price.repository.js';

const saveInput = z.object({
  workspaceId: z.uuid(),
  accountId: z.uuid(),
  providerMediaUuid: z.uuid(),
  manualPriceCents: z.number().int().positive().nullable(),
  expectedVersion: z.number().int().positive().nullable(),
});

export class FanvueVaultPriceConflictError extends Error {
  constructor() {
    super('Fanvue vault media price changed; reload before saving again');
  }
}

export class FanvueVaultCatalogService {
  constructor(
    private readonly database: NodePgDatabase,
    private readonly reads: FanvueReadService,
  ) {}

  async listFolderMedia(input: {
    workspaceId: string;
    accountId: string;
    folderName: string;
    cursor?: string;
    size?: number;
  }) {
    const live = await this.reads.listVaultFolderMedia(input);
    const prices = await withTenantTransaction(this.database, input, (transaction) =>
      listFanvueVaultMediaPrices(transaction, {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        providerMediaUuids: live.data.map((item) => item.uuid),
      }),
    );
    const byMedia = new Map(prices.map((price) => [price.providerMediaUuid, price]));
    return {
      ...live,
      data: live.data.map((item) => {
        const price = byMedia.get(item.uuid);
        return {
          ...item,
          manualPriceCents: price?.manualPriceCents ?? null,
          priceVersion: price?.version ?? null,
        };
      }),
    };
  }

  async savePrice(rawInput: z.input<typeof saveInput>) {
    const input = saveInput.parse(rawInput);
    const live = await this.reads.getMediaStatus({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      mediaUuid: input.providerMediaUuid,
    });
    if (live.uuid !== input.providerMediaUuid) throw new Error('Fanvue media identity mismatch');
    const saved = await withTenantTransaction(this.database, input, (transaction) =>
      saveFanvueVaultMediaPrice(transaction, { ...input, now: new Date() }),
    );
    if (!saved) throw new FanvueVaultPriceConflictError();
    return saved;
  }
}
