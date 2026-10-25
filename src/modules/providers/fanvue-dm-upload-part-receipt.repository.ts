import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withTenantTransaction } from '../../database/tenant-transaction.js';
import { getActiveCredential, rotateCredential } from '../credentials/credential.repository.js';
import {
  decryptCredential,
  encryptCredential,
  type MasterKeyProvider,
} from '../credentials/envelope.js';
import type { DmUploadKey } from './fanvue-dm-upload-init.repository.js';
import {
  appendFanvuePartReceipt,
  parseFanvueUploadSession,
  type FanvueUploadSession,
} from './fanvue-upload-session.js';

interface PendingPart extends Record<string, unknown> {
  id: string;
  credentialId: string;
  providerMediaUuid: string;
}

/** Only a confirmed signed PUT ETag can rotate the encrypted part plan and reopen upload. */
export async function recordFanvueDmPartReceipt(
  database: NodePgDatabase,
  keys: MasterKeyProvider,
  input: DmUploadKey & {
    session: FanvueUploadSession;
    credentialVersion: number;
    partNumber: number;
    etag: string;
  },
): Promise<boolean> {
  const current = parseFanvueUploadSession(input.session);
  const receipt = appendFanvuePartReceipt(current, input.partNumber, input.etag);
  const plaintext = Buffer.from(JSON.stringify(receipt.state));
  let encrypted;
  try {
    encrypted = await encryptCredential(plaintext, keys);
  } finally {
    plaintext.fill(0);
  }
  return withTenantTransaction(database, input, async (transaction) => {
    const selected = await transaction.execute<PendingPart>(sql`
      select id, upload_credential_id as "credentialId", provider_media_uuid as "providerMediaUuid"
      from fanvue_dm_attachments
      where workspace_id = ${input.workspaceId} and account_id = ${input.accountId}
        and client_action_id = ${input.clientActionId} and media_id = ${input.mediaId}
        and state = 'unknown' and upload_credential_id is not null
      for update
    `);
    const pending = selected.rows[0];
    if (pending?.providerMediaUuid !== current.mediaUuid) return false;
    const credential = await getActiveCredential(
      transaction,
      input.workspaceId,
      pending.credentialId,
    );
    if (credential?.version !== input.credentialVersion) return false;
    const storedPlaintext = await decryptCredential(credential, keys);
    try {
      const stored = parseFanvueUploadSession(
        JSON.parse(storedPlaintext.toString('utf8')) as unknown,
      );
      if (JSON.stringify(stored) !== JSON.stringify(current)) return false;
    } finally {
      storedPlaintext.fill(0);
    }
    const rotated = await rotateCredential(
      transaction,
      input.workspaceId,
      pending.credentialId,
      input.credentialVersion,
      encrypted,
    );
    if (!rotated) return false;
    const updated = await transaction.execute(sql`
      update fanvue_dm_attachments set state = 'uploading', updated_at = clock_timestamp()
      where id = ${pending.id} and state = 'unknown'
    `);
    if (updated.rowCount !== 1) throw new Error('Fanvue DM part receipt lost its binding');
    return true;
  });
}
