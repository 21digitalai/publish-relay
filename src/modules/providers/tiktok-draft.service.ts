import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { createUnscheduledPostRevision } from '../content/post.repository.js';
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
