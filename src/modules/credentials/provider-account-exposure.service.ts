import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { withTenantTransaction } from '../../database/tenant-transaction.js';

export type ExposureEditResult = 'unavailable' | 'unchanged' | 'active_jobs' | 'updated';
const editResultSchema = z.enum(['unavailable', 'unchanged', 'active_jobs', 'updated']);

export async function hasActiveProviderAccountJobs(
  transaction: NodePgDatabase,
  originWorkspaceId: string,
  accountId: string,
): Promise<boolean> {
  const result = await transaction.execute(sql`
    SELECT public.provider_account_has_active_jobs(
      ${originWorkspaceId}::uuid, ${accountId}::uuid
    ) AS active
  `);
  const rows: unknown = Array.isArray(result) ? result : result.rows;
  const parsed = z.array(z.object({ active: z.boolean() })).parse(rows);
  if (!parsed[0]) throw new Error('Provider account job guard returned no result');
  return parsed[0].active;
}

/** The database command owns both-workspace authorization, locking, and audit. */
export function editFacebookPageExposure(
  database: NodePgDatabase,
  input: {
    originWorkspaceId: string;
    targetWorkspaceId: string;
    accountId: string;
    userId: string;
    requestId: string;
    expose: boolean;
  },
): Promise<ExposureEditResult> {
  return withTenantTransaction(
    database,
    { workspaceId: input.originWorkspaceId, userId: input.userId },
    async (transaction) => {
      const result = await transaction.execute<{ result: ExposureEditResult }>(sql`
        SELECT public.edit_facebook_page_exposure(
          ${input.originWorkspaceId}::uuid,
          ${input.targetWorkspaceId}::uuid,
          ${input.accountId}::uuid,
          ${input.expose},
          ${input.requestId}
        ) AS result
      `);
      const rows: unknown = Array.isArray(result) ? result : result.rows;
      const first: unknown = Array.isArray(rows) ? rows[0] : undefined;
      return editResultSchema.parse(
        first && typeof first === 'object' ? Reflect.get(first, 'result') : undefined,
      );
    },
  );
}
