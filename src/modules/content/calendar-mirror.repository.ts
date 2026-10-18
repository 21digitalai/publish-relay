import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

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

export function getExposedPageCalendarJob(
  database: NodePgDatabase,
  input: { workspaceId: string; userId: string; jobId: string },
) {
  return withTenantTransaction(
    database,
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
    },
    async (transaction) => {
      const result = await transaction.execute<
        Record<string, unknown> & {
          id: string;
          providerAccountId: string;
          providerAccountName: string;
          originWorkspaceName: string;
          state: string;
          scheduledAt: Date;
          caption: string | null;
          linkUrl: string | null;
          media: {
            id: string;
            mimeType: string;
            byteSize: number;
            position: number;
            ready: boolean;
          }[];
        }
      >(sql`
      SELECT id, provider_account_id AS "providerAccountId",
        provider_account_name AS "providerAccountName",
        origin_workspace_name AS "originWorkspaceName", state,
        scheduled_at AS "scheduledAt", caption, link_url AS "linkUrl", media
      FROM public.get_exposed_page_calendar_job(${input.workspaceId}::uuid, ${input.jobId}::uuid)
    `);
      const rows: unknown = Array.isArray(result) ? result : result.rows;
      const parsed = z
        .array(
          z.object({
            id: z.uuid(),
            providerAccountId: z.uuid(),
            providerAccountName: z.string(),
            originWorkspaceName: z.string(),
            state: z.string(),
            scheduledAt: z.coerce.date(),
            caption: z.string().nullable(),
            linkUrl: z.string().nullable(),
            media: z.array(
              z.object({
                id: z.uuid(),
                mimeType: z.string(),
                byteSize: z.number(),
                position: z.number(),
                ready: z.boolean(),
              }),
            ),
          }),
        )
        .parse(rows);
      return parsed[0] ?? null;
    },
  );
}

export function getExposedPageCalendarMedia(
  database: NodePgDatabase,
  input: { workspaceId: string; userId: string; jobId: string; mediaId: string },
) {
  return withTenantTransaction(
    database,
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
    },
    async (transaction) => {
      const result = await transaction.execute(sql`
      SELECT storage_key AS "storageKey", mime_type AS "mimeType", byte_size AS "byteSize"
      FROM public.get_exposed_page_calendar_media(
        ${input.workspaceId}::uuid, ${input.jobId}::uuid, ${input.mediaId}::uuid
      )
    `);
      const rows: unknown = Array.isArray(result) ? result : result.rows;
      return (
        z
          .array(
            z.object({
              storageKey: z.string(),
              mimeType: z.string(),
              byteSize: z.number(),
            }),
          )
          .parse(rows)[0] ?? null
      );
    },
  );
}
