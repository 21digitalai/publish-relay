import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { fanvueVaultMediaPrices } from '../../database/schema.js';

export interface FanvueVaultMediaPrice {
  providerMediaUuid: string;
  manualPriceCents: number | null;
  version: number;
  updatedAt: Date;
}

const projection = {
  providerMediaUuid: fanvueVaultMediaPrices.providerMediaUuid,
  manualPriceCents: fanvueVaultMediaPrices.manualPriceCents,
  version: fanvueVaultMediaPrices.version,
  updatedAt: fanvueVaultMediaPrices.updatedAt,
};

export async function listFanvueVaultMediaPrices(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; providerMediaUuids: string[] },
): Promise<FanvueVaultMediaPrice[]> {
  if (input.providerMediaUuids.length === 0) return [];
  return database
    .select(projection)
    .from(fanvueVaultMediaPrices)
    .where(
      and(
        eq(fanvueVaultMediaPrices.workspaceId, input.workspaceId),
        eq(fanvueVaultMediaPrices.accountId, input.accountId),
        inArray(fanvueVaultMediaPrices.providerMediaUuid, input.providerMediaUuids),
      ),
    );
}

export async function saveFanvueVaultMediaPrice(
  database: NodePgDatabase,
  input: {
    workspaceId: string;
    accountId: string;
    providerMediaUuid: string;
    manualPriceCents: number | null;
    expectedVersion: number | null;
    now: Date;
  },
): Promise<FanvueVaultMediaPrice | null> {
  if (input.expectedVersion === null) {
    const inserted = await database
      .insert(fanvueVaultMediaPrices)
      .values({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        providerMediaUuid: input.providerMediaUuid,
        manualPriceCents: input.manualPriceCents,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing()
      .returning(projection);
    return inserted[0] ?? null;
  }

  const updated = await database
    .update(fanvueVaultMediaPrices)
    .set({
      manualPriceCents: input.manualPriceCents,
      version: sql`${fanvueVaultMediaPrices.version} + 1`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(fanvueVaultMediaPrices.workspaceId, input.workspaceId),
        eq(fanvueVaultMediaPrices.accountId, input.accountId),
        eq(fanvueVaultMediaPrices.providerMediaUuid, input.providerMediaUuid),
        eq(fanvueVaultMediaPrices.version, input.expectedVersion),
      ),
    )
    .returning(projection);
  return updated[0] ?? null;
}
