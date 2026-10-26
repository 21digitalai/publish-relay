import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';

interface ReadyMedia extends Record<string, unknown> {
  mediaId: string;
  mediaUuid: string;
}

/** Resolve only exact ready local media bound to this creator and send action. */
export async function getReadyFanvueDmMedia(
  database: NodePgDatabase,
  input: { workspaceId: string; accountId: string; clientActionId: string; mediaIds: string[] },
): Promise<Map<string, string>> {
  if (!input.mediaIds.length) return new Map();
  return withTenantTransaction(database, input, async (transaction) => {
    const result = await transaction.execute<ReadyMedia>(sql`
      select dm.media_id as "mediaId", dm.provider_media_uuid as "mediaUuid"
      from fanvue_dm_attachments dm
      join media_objects media on media.workspace_id = dm.workspace_id and media.id = dm.media_id
      join provider_accounts account on account.workspace_id = dm.workspace_id and account.id = dm.account_id
      join provider_connections connection
        on connection.workspace_id = account.workspace_id and connection.id = account.connection_id
      where dm.workspace_id = ${input.workspaceId} and dm.account_id = ${input.accountId}
        and dm.client_action_id = ${input.clientActionId}
        and dm.media_id in (${sql.join(
          input.mediaIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        and dm.state = 'ready' and dm.provider_media_uuid is not null
        and media.state = 'ready' and media.deleted_at is null
        and account.destination_provider = 'fanvue' and account.availability = 'active'
        and account.disconnected_at is null
        and connection.provider = 'fanvue' and connection.status = 'active'
        and connection.external_subject_id = account.remote_account_id
        and connection.revoked_at is null
    `);
    return new Map(result.rows.map((row) => [row.mediaId, row.mediaUuid]));
  });
}
