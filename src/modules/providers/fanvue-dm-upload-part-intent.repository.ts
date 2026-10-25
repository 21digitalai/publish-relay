import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import type { DmUploadKey } from './fanvue-dm-upload-init.repository.js';
import { loadFanvueDmUploadSession } from './fanvue-dm-upload-source.js';
import { fanvuePartRange } from './fanvue-media-upload-plan.js';

/** Reserve exactly one signed PUT; unknown blocks every automatic replay after a lost response. */
export async function reserveFanvueDmUploadPart(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: DmUploadKey & { partNumber: number },
) {
  const { session, credentialVersion } = await loadFanvueDmUploadSession(database, keys, input);
  if (input.partNumber !== session.parts.length + 1)
    throw new Error('Fanvue DM upload part is not next in sequence');
  const range = fanvuePartRange(session, input.partNumber);
  const reserved = await withTenantTransaction(database, input, async (transaction) => {
    const result = await transaction.execute(sql`
      update fanvue_dm_attachments dm set state = 'unknown', updated_at = clock_timestamp()
      where dm.workspace_id = ${input.workspaceId} and dm.account_id = ${input.accountId}
        and dm.client_action_id = ${input.clientActionId} and dm.media_id = ${input.mediaId}
        and dm.state = 'uploading' and dm.provider_media_uuid = ${session.mediaUuid}
        and exists (
          select 1 from credentials credential
          where credential.workspace_id = dm.workspace_id and credential.id = dm.upload_credential_id
            and credential.version = ${credentialVersion} and credential.revoked_at is null
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
  return reserved ? { session, credentialVersion, range } : null;
}
