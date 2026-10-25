import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { createCredential } from '../credentials/credential.repository.js';
import { encryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
import { parseFanvueUploadSession, type FanvueUploadSession } from './fanvue-upload-session.js';

export interface DmUploadKey {
  workspaceId: string;
  accountId: string;
  clientActionId: string;
  mediaId: string;
}

interface LocalMedia extends Record<string, unknown> {
  byteSize: number;
  mimeType: string;
}

export async function getBoundFanvueDmMedia(database: NodePgDatabase, key: DmUploadKey) {
  return withTenantTransaction(database, key, async (transaction) => {
    const result = await transaction.execute<LocalMedia>(sql`
      select media.byte_size::int as "byteSize", media.mime_type as "mimeType"
      from fanvue_dm_attachments dm
      join media_objects media on media.workspace_id = dm.workspace_id and media.id = dm.media_id
      join provider_accounts account on account.workspace_id = dm.workspace_id and account.id = dm.account_id
      where dm.workspace_id = ${key.workspaceId} and dm.account_id = ${key.accountId}
        and dm.client_action_id = ${key.clientActionId} and dm.media_id = ${key.mediaId}
        and dm.state = 'bound' and media.state = 'ready' and media.deleted_at is null
        and account.destination_provider = 'fanvue' and account.availability = 'active'
        and account.disconnected_at is null
    `);
    return result.rows[0] ?? null;
  });
}

/** Unknown is durable before the provider create request; a lost result cannot start twice. */
export async function reserveFanvueDmSession(database: NodePgDatabase, key: DmUploadKey) {
  return withTenantTransaction(database, key, async (transaction) => {
    const result = await transaction.execute(sql`
      update fanvue_dm_attachments dm set state = 'unknown', updated_at = clock_timestamp()
      where dm.workspace_id = ${key.workspaceId} and dm.account_id = ${key.accountId}
        and dm.client_action_id = ${key.clientActionId} and dm.media_id = ${key.mediaId}
        and dm.state = 'bound' and dm.upload_credential_id is null
        and exists (
          select 1 from media_objects media
          where media.workspace_id = dm.workspace_id and media.id = dm.media_id
            and media.state = 'ready' and media.deleted_at is null
        )
        and exists (
          select 1 from provider_accounts account
          where account.workspace_id = dm.workspace_id and account.id = dm.account_id
            and account.destination_provider = 'fanvue' and account.availability = 'active'
            and account.disconnected_at is null
        )
    `);
    return (result.rowCount ?? 0) === 1;
  });
}

/** A confirmed session is persisted even if account authority changed during the provider call. */
export async function recordFanvueDmSession(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: DmUploadKey & { session: FanvueUploadSession },
): Promise<boolean> {
  const session = parseFanvueUploadSession(input.session);
  if (session.parts.length) throw new Error('New Fanvue DM session has part receipts');
  const plaintext = Buffer.from(JSON.stringify(session));
  let encrypted;
  try {
    encrypted = await encryptCredential(plaintext, keys);
  } finally {
    plaintext.fill(0);
  }
  return withTenantTransaction(database, input, async (transaction) => {
    const selected = await transaction.execute<{ id: string }>(sql`
      select id from fanvue_dm_attachments
      where workspace_id = ${input.workspaceId} and account_id = ${input.accountId}
        and client_action_id = ${input.clientActionId} and media_id = ${input.mediaId}
        and state = 'unknown' and upload_credential_id is null
      for update
    `);
    if (!selected.rows[0]) return false;
    const credential = await createCredential(transaction, input.workspaceId, encrypted);
    const result = await transaction.execute(sql`
      update fanvue_dm_attachments set state = 'uploading',
        provider_media_uuid = ${session.mediaUuid}, upload_credential_id = ${credential.id},
        updated_at = clock_timestamp()
      where id = ${selected.rows[0].id} and state = 'unknown' and upload_credential_id is null
    `);
    if (result.rowCount !== 1) throw new Error('Fanvue DM session receipt lost its binding');
    return true;
  });
}
