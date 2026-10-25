import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MediaStorage } from '../content/media-storage.js';
import { getActiveCredential } from '../credentials/credential.repository.js';
import { decryptCredential, type MasterKeyProvider } from '../credentials/envelope.js';
import type { DmUploadKey } from './fanvue-dm-upload-init.repository.js';
import { parseFanvueUploadSession } from './fanvue-upload-session.js';

interface DmSource extends Record<string, unknown> {
  storageKey: string;
  sha256: string;
  byteSize: number;
  credentialId: string;
  providerMediaUuid: string;
}

/** Resolve only one active creator's exact bound ready attachment; never reuse job staging. */
async function loadDmSource(database: NodePgDatabase, key: DmUploadKey): Promise<DmSource> {
  const source = await withTenantTransaction(database, key, async (transaction) => {
    const result = await transaction.execute<DmSource>(sql`
      select media.storage_key as "storageKey", media.sha256,
        media.byte_size::int as "byteSize", dm.upload_credential_id as "credentialId",
        dm.provider_media_uuid as "providerMediaUuid"
      from fanvue_dm_attachments dm
      join media_objects media on media.workspace_id = dm.workspace_id and media.id = dm.media_id
      join provider_accounts account on account.workspace_id = dm.workspace_id and account.id = dm.account_id
      join provider_connections connection
        on connection.workspace_id = account.workspace_id and connection.id = account.connection_id
      where dm.workspace_id = ${key.workspaceId} and dm.account_id = ${key.accountId}
        and dm.client_action_id = ${key.clientActionId} and dm.media_id = ${key.mediaId}
        and dm.state = 'uploading' and dm.upload_credential_id is not null
        and dm.provider_media_uuid is not null
        and media.state = 'ready' and media.deleted_at is null
        and account.destination_provider = 'fanvue' and account.availability = 'active'
        and account.disconnected_at is null
        and connection.provider = 'fanvue' and connection.status = 'active'
        and connection.external_subject_id = account.remote_account_id
        and connection.revoked_at is null
    `);
    return result.rows[0] ?? null;
  });
  if (!source) throw new Error('Fanvue DM upload source is unavailable');
  return source;
}

export async function openFanvueDmUploadRange(
  database: NodePgDatabase,
  storage: MediaStorage,
  input: DmUploadKey & { start: number; end: number },
) {
  if (!storage.openVerifiedRange) throw new Error('Verified range storage is required');
  const source = await loadDmSource(database, input);
  if (
    !Number.isSafeInteger(input.start) ||
    !Number.isSafeInteger(input.end) ||
    input.start < 0 ||
    input.end < input.start ||
    input.end >= source.byteSize
  )
    throw new Error('Fanvue DM upload range is unavailable');
  const stream = await storage.openVerifiedRange({
    storageKey: source.storageKey,
    sha256: source.sha256,
    byteSize: source.byteSize,
    start: input.start,
    end: input.end,
  });
  if (!stream) throw new Error('Fanvue DM media failed verification');
  return { stream, byteSize: source.byteSize };
}

export async function loadFanvueDmUploadSession(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: DmUploadKey,
) {
  const source = await loadDmSource(database, input);
  const credential = await withTenantTransaction(database, input, (transaction) =>
    getActiveCredential(transaction, input.workspaceId, source.credentialId),
  );
  if (!credential) throw new Error('Fanvue DM upload session is unavailable');
  const plaintext = await decryptCredential(credential, keys);
  try {
    const session = parseFanvueUploadSession(JSON.parse(plaintext.toString('utf8')) as unknown);
    if (session.mediaUuid !== source.providerMediaUuid || session.byteSize !== source.byteSize)
      throw new Error('Fanvue DM upload session does not match its attachment');
    return { session, credentialVersion: credential.version };
  } finally {
    plaintext.fill(0);
  }
}
