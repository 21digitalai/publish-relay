import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import { getExposedPageCalendarMedia } from '../src/modules/content/calendar-mirror.repository.js';

const input = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  jobId: '33333333-3333-4333-8333-333333333333',
  mediaId: '44444444-4444-4444-8444-444444444444',
};

function databaseWithNativePgMediaRow(byteSize: string): NodePgDatabase {
  let queryCount = 0;
  const transaction = {
    execute: () => {
      queryCount += 1;
      if (queryCount < 3) return Promise.resolve({ rows: [] });
      return Promise.resolve({
        rows: [{ storageKey: 'origin/private.jpg', mimeType: 'image/png', byteSize }],
      });
    },
  };
  return {
    transaction: async (operation: (tx: typeof transaction) => Promise<unknown>) =>
      operation(transaction),
  } as unknown as NodePgDatabase;
}

describe('exposed Page calendar media with native PostgreSQL bigint rows', () => {
  it('accepts a decimal byte size returned as a string', async () => {
    await expect(
      getExposedPageCalendarMedia(databaseWithNativePgMediaRow('2481024'), input),
    ).resolves.toEqual({
      storageKey: 'origin/private.jpg',
      mimeType: 'image/png',
      byteSize: 2481024,
    });
  });

  it('rejects byte sizes outside JavaScript safe integer precision', async () => {
    await expect(
      getExposedPageCalendarMedia(databaseWithNativePgMediaRow('9007199254740992'), input),
    ).rejects.toThrow();
  });
});
