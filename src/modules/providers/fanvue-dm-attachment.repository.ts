import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';

interface AttachmentKey {
  workspaceId: string;
  accountId: string;
  clientActionId: string;
  mediaId: string;
}

/** Binding locks the media row shared by retention and explicit deletion before any provider upload. */
export async function bindFanvueDmAttachment(database: NodePgDatabase, key: AttachmentKey) {
  return withTenantTransaction(database, key, async (transaction) => {
    const media = await transaction.execute<{ state: string }>(sql`
      select state from media_objects
      where workspace_id = ${key.workspaceId} and id = ${key.mediaId}
      for update
    `);
    if (media.rows[0]?.state !== 'ready') return false;
    const account = await transaction.execute<{ id: string }>(sql`
      select id from provider_accounts
      where workspace_id = ${key.workspaceId} and id = ${key.accountId}
        and destination_provider = 'fanvue' and availability = 'active'
    `);
    if (!account.rows[0]) return false;
    const result = await transaction.execute<{ id: string }>(sql`
      insert into fanvue_dm_attachments (workspace_id, account_id, client_action_id, media_id)
      values (${key.workspaceId}, ${key.accountId}, ${key.clientActionId}, ${key.mediaId})
      on conflict (workspace_id, account_id, client_action_id, media_id) do nothing
      returning id
    `);
    if (result.rows[0]) return true;
    const existing = await transaction.execute<{ state: string }>(sql`
      select state from fanvue_dm_attachments
      where workspace_id = ${key.workspaceId} and account_id = ${key.accountId}
        and client_action_id = ${key.clientActionId} and media_id = ${key.mediaId}
    `);
    return existing.rows[0]?.state !== 'released';
  });
}

/** Only a never-uploaded binding is reversible without provider reconciliation. */
export async function releaseUnstartedFanvueDmAttachment(
  database: NodePgDatabase,
  key: AttachmentKey,
): Promise<boolean> {
  return withTenantTransaction(database, key, async (transaction) => {
    const result = await transaction.execute(sql`
      update fanvue_dm_attachments set state = 'released', updated_at = now()
      where workspace_id = ${key.workspaceId} and account_id = ${key.accountId}
        and client_action_id = ${key.clientActionId} and media_id = ${key.mediaId}
        and state = 'bound'
    `);
    return (result.rowCount ?? 0) > 0;
  });
}
