import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { DmUploadKey } from './fanvue-dm-upload-init.repository.js';
import type { FanvueUploadSession } from './fanvue-upload-session.js';

interface CompletionReceipt {
  session: FanvueUploadSession;
  credentialVersion: number;
}

/** Persist an ambiguous completion intent before PATCH; no second PATCH is eligible. */
export async function reserveFanvueDmCompletion(
  database: NodePgDatabase,
  input: DmUploadKey & CompletionReceipt,
): Promise<boolean> {
  return withTenantTransaction(database, input, async (transaction) => {
    const result = await transaction.execute(sql`
      update fanvue_dm_attachments dm set state = 'unknown', updated_at = clock_timestamp()
      where dm.workspace_id = ${input.workspaceId} and dm.account_id = ${input.accountId}
        and dm.client_action_id = ${input.clientActionId} and dm.media_id = ${input.mediaId}
        and dm.state = 'uploading' and dm.provider_media_uuid = ${input.session.mediaUuid}
        and exists (
          select 1 from credentials credential
          where credential.workspace_id = dm.workspace_id and credential.id = dm.upload_credential_id
            and credential.version = ${input.credentialVersion} and credential.revoked_at is null
        )
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

/** A confirmed PATCH is durable even if connection authority changed during the request. */
export async function confirmFanvueDmCompletion(
  database: NodePgDatabase,
  input: DmUploadKey & CompletionReceipt,
): Promise<boolean> {
  return withTenantTransaction(database, input, async (transaction) => {
    const result = await transaction.execute(sql`
      update fanvue_dm_attachments dm set state = 'processing', updated_at = clock_timestamp()
      where dm.workspace_id = ${input.workspaceId} and dm.account_id = ${input.accountId}
        and dm.client_action_id = ${input.clientActionId} and dm.media_id = ${input.mediaId}
        and dm.state = 'unknown' and dm.provider_media_uuid = ${input.session.mediaUuid}
        and exists (
          select 1 from credentials credential
          where credential.workspace_id = dm.workspace_id and credential.id = dm.upload_credential_id
            and credential.version = ${input.credentialVersion} and credential.revoked_at is null
        )
    `);
    return result.rowCount === 1;
  });
}
