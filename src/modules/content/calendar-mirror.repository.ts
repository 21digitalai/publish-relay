import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';

export interface CalendarMirrorCursor {
  scheduledAt: Date;
  id: string;
}

export interface CalendarMirrorQuery {
  workspaceId: string;
  userId: string;
  startsAt: Date;
  endsAt: Date;
  limit: number;
  after?: CalendarMirrorCursor;
}

type CalendarMirrorRow = Record<string, unknown> & {
  id: string;
  providerAccountId: string;
  providerAccountName: string;
  originWorkspaceName: string;
  state: string;
  scheduledAt: Date;
  contentPreview: string;
  mediaCount: number;
};

export function listExposedPageCalendarJobs(database: NodePgDatabase, input: CalendarMirrorQuery) {
  return withTenantTransaction(
    database,
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
    },
    async (transaction) => {
      const result = await transaction.execute<CalendarMirrorRow>(sql`
      SELECT id, provider_account_id AS "providerAccountId",
        provider_account_name AS "providerAccountName",
        origin_workspace_name AS "originWorkspaceName", state,
        scheduled_at AS "scheduledAt", content_preview AS "contentPreview",
        media_count AS "mediaCount"
      FROM public.list_exposed_page_calendar_jobs(
        ${input.workspaceId}::uuid, ${input.startsAt}, ${input.endsAt},
        ${input.after?.scheduledAt ?? null}::timestamptz,
        ${input.after?.id ?? null}::uuid, ${input.limit}
      )
    `);
      return (Array.isArray(result) ? result : result.rows) as CalendarMirrorRow[];
    },
  );
}
