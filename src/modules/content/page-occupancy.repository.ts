import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { withTenantTransaction } from '../../database/tenant-transaction.js';

export interface PageOccupancyQuery {
  workspaceId: string;
  userId: string;
  accountId: string;
  startsAt: Date;
  endsAt: Date;
  limit: number;
  beforeScheduledAt?: Date;
}

export function listFacebookPageOccupancy(database: NodePgDatabase, input: PageOccupancyQuery) {
  return withTenantTransaction(
    database,
    { workspaceId: input.workspaceId, userId: input.userId },
    async (transaction) => {
      const result = await transaction.execute(sql`
        SELECT scheduled_at AS "scheduledAt", job_count AS "jobCount"
        FROM public.list_facebook_page_occupancy(
          ${input.workspaceId}::uuid, ${input.accountId}::uuid,
          ${input.startsAt}, ${input.endsAt},
          ${input.beforeScheduledAt ?? null}::timestamptz, ${input.limit}
        )
      `);
      const rows: unknown = Array.isArray(result) ? result : result.rows;
      return z
        .array(z.object({ scheduledAt: z.coerce.date(), jobCount: z.number().int().positive() }))
        .parse(rows);
    },
  );
}
