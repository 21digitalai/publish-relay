import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { DmUploadKey } from './fanvue-dm-upload-init.repository.js';

/** Resolve only an exact active-account local attachment awaiting provider processing. */
export async function getFanvueDmProcessingUuid(
  database: NodePgDatabase,
  input: DmUploadKey,
): Promise<string | null> {
  return withTenantTransaction(database, input, async (transaction) => {
    const result = await transaction.execute<{ mediaUuid: string }>(sql`
      select dm.provider_media_uuid as "mediaUuid"
      from fanvue_dm_attachments dm
      join media_objects media on media.workspace_id = dm.workspace_id and media.id = dm.media_id
      join provider_accounts account on account.workspace_id = dm.workspace_id and account.id = dm.account_id
      join provider_connections connection
        on connection.workspace_id = account.workspace_id and connection.id = account.connection_id
      where dm.workspace_id = ${input.workspaceId} and dm.account_id = ${input.accountId}
        and dm.client_action_id = ${input.clientActionId} and dm.media_id = ${input.mediaId}
        and dm.state = 'processing' and dm.provider_media_uuid is not null
        and media.state = 'ready' and media.deleted_at is null
        and account.destination_provider = 'fanvue' and account.availability = 'active'
        and account.disconnected_at is null
        and connection.provider = 'fanvue' and connection.status = 'active'
        and connection.external_subject_id = account.remote_account_id
        and connection.revoked_at is null
    `);
    return result.rows[0]?.mediaUuid ?? null;
  });
}

export async function settleFanvueDmReadiness(
  database: NodePgDatabase,
  input: DmUploadKey & { mediaUuid: string; state: 'ready' | 'failed' },
): Promise<boolean> {
  return withTenantTransaction(database, input, async (transaction) => {
    const result = await transaction.execute(sql`
      update fanvue_dm_attachments dm set state = ${input.state}, updated_at = clock_timestamp()
      where dm.workspace_id = ${input.workspaceId} and dm.account_id = ${input.accountId}
        and dm.client_action_id = ${input.clientActionId} and dm.media_id = ${input.mediaId}
        and dm.state = 'processing' and dm.provider_media_uuid = ${input.mediaUuid}
        and exists (
          select 1 from media_objects media
          where media.workspace_id = dm.workspace_id and media.id = dm.media_id
            and media.state = 'ready' and media.deleted_at is null
        )
        and exists (
          select 1 from provider_accounts account
          join provider_connections connection
            on connection.workspace_id = account.workspace_id and connection.id = account.connection_id
          where account.workspace_id = dm.workspace_id and account.id = dm.account_id
            and account.destination_provider = 'fanvue' and account.availability = 'active'
            and account.disconnected_at is null
            and connection.provider = 'fanvue' and connection.status = 'active'
            and connection.external_subject_id = account.remote_account_id
            and connection.revoked_at is null
        )
    `);
    return result.rowCount === 1;
  });
}
