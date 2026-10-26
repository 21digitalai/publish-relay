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
      select account.id from provider_accounts account
      join provider_connections connection
        on connection.workspace_id = account.workspace_id and connection.id = account.connection_id
      where account.workspace_id = ${key.workspaceId} and account.id = ${key.accountId}
        and account.destination_provider = 'fanvue' and account.availability = 'active'
        and account.disconnected_at is null
        and connection.provider = 'fanvue' and connection.status = 'active'
        and connection.external_subject_id = account.remote_account_id
        and connection.revoked_at is null
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

export async function getFanvueDmAttachmentState(database: NodePgDatabase, key: AttachmentKey) {
  return withTenantTransaction(database, key, async (transaction) => {
    const result = await transaction.execute<{ state: string }>(sql`
      select state from fanvue_dm_attachments
      where workspace_id = ${key.workspaceId} and account_id = ${key.accountId}
        and client_action_id = ${key.clientActionId} and media_id = ${key.mediaId}
    `);
    return result.rows[0]?.state ?? null;
  });
}
