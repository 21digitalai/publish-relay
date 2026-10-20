import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import {
  createUnscheduledPostRevision,
  reviseUnscheduledTikTokPost,
} from '../content/post.repository.js';
import {
  allowAllActionPolicy,
  enforceWorkspaceAction,
  type ActionPolicy,
} from '../policy/action-policy.js';
import {
  TikTokConsentInvalidError,
  tiktokRevisionContentSchema,
} from './tiktok-consent.service.js';

const draftSchema = z.strictObject({
  workspaceId: z.uuid(),
  userId: z.uuid(),
  accountId: z.uuid(),
  requestId: z.string().min(1),
  content: tiktokRevisionContentSchema,
});

export type TikTokDraftCommand = z.input<typeof draftSchema>;
export const tiktokDraftRequestSchema = draftSchema.omit({
  workspaceId: true,
  userId: true,
  requestId: true,
});

export const tiktokDraftRevisionSchema = z.strictObject({ content: tiktokRevisionContentSchema });

export class TikTokDraftUnavailableError extends Error {}

async function requireEditor(transaction: NodePgDatabase, workspaceId: string, userId: string) {
  const member = await transaction.execute(sql`
    select 1 from memberships where workspace_id = ${workspaceId} and user_id = ${userId}
      and role in ('owner', 'admin', 'editor')
  `);
  if (member.rows.length !== 1) throw new TikTokDraftUnavailableError();
}

interface PreparedRow extends Record<string, unknown> {
  postId: string;
  revisionId: string;
  content: unknown;
  mediaId: string;
  mimeType: string;
  byteSize: number;
  durationMs: number | null;
  ready: boolean;
  createdAt: string;
}

function preparedSummary(row: PreparedRow, detail = false) {
  const content = tiktokRevisionContentSchema.safeParse(row.content);
  if (!content.success || content.data.mediaId !== row.mediaId)
    throw new TikTokDraftUnavailableError();
  return {
    postId: row.postId,
    revisionId: row.revisionId,
    ...(detail
      ? { content: content.data }
      : { captionPreview: content.data.caption.slice(0, 160) }),
    createdAt: row.createdAt,
    media: {
      id: row.mediaId,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      durationMs: row.durationMs,
      ready: row.ready,
      previewUrl: row.ready ? `/api/workflow/media/${row.mediaId}` : null,
    },
  };
}

const preparedQuery = sql`
  from posts p
  join lateral (select id, content from post_revisions where workspace_id = p.workspace_id
    and post_id = p.id order by revision_number desc limit 1) r on true
  join revision_media rm on rm.workspace_id = p.workspace_id and rm.revision_id = r.id
    and rm.position = 0
  join media_objects m on m.workspace_id = rm.workspace_id and m.id = rm.media_id
  where p.workspace_id = `;

export async function listPreparedTikTokDrafts(
  database: NodePgDatabase,
  input: { workspaceId: string; userId: string; limit: number; before?: string; beforeId?: string },
) {
  return withTenantTransaction(database, input, async (transaction) => {
    await transaction.execute(sql`set transaction read only`);
    await requireEditor(transaction, input.workspaceId, input.userId);
    const rows = await transaction.execute<PreparedRow>(sql`
      select p.id as "postId", r.id as "revisionId", r.content,
        m.id as "mediaId", m.mime_type as "mimeType", m.byte_size as "byteSize",
        m.duration_ms as "durationMs", (m.state = 'ready' and m.deleted_at is null) as ready,
        to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"
      ${preparedQuery} ${input.workspaceId}
        and not exists (select 1 from publication_jobs j where j.workspace_id = p.workspace_id and j.post_id = p.id)
        and r.content->>'kind' = 'video' and r.content->>'schemaVersion' = '1'
        and (${input.before ?? null}::timestamptz is null or
          (p.created_at, p.id) < (${input.before ?? null}::timestamptz, ${input.beforeId ?? null}::uuid))
      order by p.created_at desc, p.id desc limit ${input.limit}
    `);
    return rows.rows.map((row) => preparedSummary(row));
  });
}

export async function getPreparedTikTokDraft(
  database: NodePgDatabase,
  input: { workspaceId: string; userId: string; postId: string },
) {
  return withTenantTransaction(database, input, async (transaction) => {
    await transaction.execute(sql`set transaction read only`);
    await requireEditor(transaction, input.workspaceId, input.userId);
    const rows = await transaction.execute<PreparedRow>(sql`
      select p.id as "postId", r.id as "revisionId", r.content,
        m.id as "mediaId", m.mime_type as "mimeType", m.byte_size as "byteSize",
        m.duration_ms as "durationMs", (m.state = 'ready' and m.deleted_at is null) as ready,
        to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"
      ${preparedQuery} ${input.workspaceId} and p.id = ${input.postId}
        and not exists (select 1 from publication_jobs j where j.workspace_id = p.workspace_id and j.post_id = p.id)
    `);
    const row = rows.rows[0];
    if (rows.rows.length !== 1 || !row) throw new TikTokDraftUnavailableError();
    return preparedSummary(row, true);
  });
}

export async function revisePreparedTikTokDraftInTransaction(
  transaction: NodePgDatabase,
  input: {
    workspaceId: string;
    userId: string;
    postId: string;
    content: z.infer<typeof tiktokRevisionContentSchema>;
    requestId: string;
  },
  policy: ActionPolicy = allowAllActionPolicy,
) {
  await requireEditor(transaction, input.workspaceId, input.userId);
  await enforceWorkspaceAction(transaction, policy, {
    workspaceId: input.workspaceId,
    actor: { type: 'user', id: input.userId },
    action: 'publication.revise',
    request: { provider: 'tiktok', requestId: input.requestId },
  });
  return reviseUnscheduledTikTokPost(transaction, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    postId: input.postId,
    content: input.content,
    mediaId: input.content.mediaId,
  });
}

export async function prepareTikTokDraft(
  database: NodePgDatabase,
  rawInput: TikTokDraftCommand,
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<{ postId: string; revisionId: string }> {
  const input = draftSchema.parse(rawInput);
  return withTenantTransaction(database, input, (transaction) =>
    prepareTikTokDraftInTransaction(transaction, input, policy),
  );
}

export async function prepareTikTokDraftInTransaction(
  transaction: NodePgDatabase,
  rawInput: TikTokDraftCommand,
  policy: ActionPolicy = allowAllActionPolicy,
): Promise<{ postId: string; revisionId: string }> {
  const input = draftSchema.parse(rawInput);
  const workspace = await transaction.execute(
    sql`select id from workspaces where id = ${input.workspaceId} for update`,
  );
  if (workspace.rows.length !== 1) throw new TikTokConsentInvalidError();
  const member = await transaction.execute(sql`
      select 1 from memberships where workspace_id = ${input.workspaceId}
        and user_id = ${input.userId} and role in ('owner', 'admin', 'editor')
    `);
  if (member.rows.length !== 1) throw new TikTokConsentInvalidError();
  await enforceWorkspaceAction(transaction, policy, {
    workspaceId: input.workspaceId,
    actor: { type: 'user', id: input.userId },
    action: 'publication.create',
    request: { provider: 'tiktok', requestId: input.requestId },
  });
  const account = await transaction.execute(sql`
      select a.id from provider_accounts a
      join provider_connections c on c.workspace_id = a.workspace_id and c.id = a.connection_id
      where a.workspace_id = ${input.workspaceId} and a.id = ${input.accountId}
        and a.destination_provider = 'tiktok' and a.availability = 'active'
        and a.disconnected_at is null and c.provider = 'tiktok' and c.status = 'active'
        and c.revoked_at is null and c.scopes ? 'video.publish'
        and c.refresh_expires_at > now()
      for update of c
    `);
  if (account.rows.length !== 1) throw new TikTokConsentInvalidError();
  const media = await transaction.execute(sql`
      select id from media_objects where workspace_id = ${input.workspaceId}
        and id = ${input.content.mediaId} and state = 'ready' and deleted_at is null
        and mime_type = 'video/mp4' and duration_ms > 0 for update
    `);
  if (media.rows.length !== 1) throw new TikTokConsentInvalidError();
  return createUnscheduledPostRevision(transaction, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    content: input.content,
    mediaId: input.content.mediaId,
  });
}
