import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withProviderStagingLock } from '../content/provider-staging-lock.js';
import type { MediaStorage } from '../content/media-storage.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import type { DmUploadKey } from './fanvue-dm-upload-init.repository.js';
import { reserveFanvueDmUploadPart } from './fanvue-dm-upload-part-intent.repository.js';
import { recordFanvueDmPartReceipt } from './fanvue-dm-upload-part-receipt.repository.js';
import { loadFanvueDmUploadSession, openFanvueDmUploadRange } from './fanvue-dm-upload-source.js';
import type { FanvueMediaUploadClient } from './fanvue-media-upload-client.js';
import { fanvuePartRange } from './fanvue-media-upload-plan.js';
import { readExactPart } from './fanvue-upload-part.service.js';

/** One bounded verified signed PUT; intent precedes bytes, uncertain outcomes never resend. */
export async function uploadFanvueDmPart(
  database: NodePgDatabase,
  storage: MediaStorage,
  client: FanvueMediaUploadClient,
  keys: MasterKeyProvider,
  input: DmUploadKey & { partNumber: number; accessToken: string },
): Promise<void> {
  const lockKey = `${input.workspaceId}:${input.accountId}:${input.clientActionId}:${input.mediaId}`;
  await withProviderStagingLock(database, lockKey, async () => {
    if (!input.accessToken) throw new Error('Selected Fanvue creator token is required');
    const { session } = await loadFanvueDmUploadSession(database, keys, input);
    if (input.partNumber !== session.parts.length + 1)
      throw new Error('Fanvue DM upload part is not next in sequence');
    const range = fanvuePartRange(session, input.partNumber);
    const source = await openFanvueDmUploadRange(database, storage, {
      ...input,
      start: range.start,
      end: range.end,
    });
    if (source.byteSize !== session.byteSize)
      throw new Error('Fanvue DM upload session does not match local media');
    const bytes = await readExactPart(source.stream, range.byteLength);
    try {
      const signed = await client.signParts(
        input.accessToken,
        session.uploadId,
        input.partNumber,
        input.partNumber,
      );
      const url = signed.parts[0]?.url;
      if (
        signed.partSize !== session.partSize ||
        !url ||
        signed.parts[0]?.partNumber !== input.partNumber
      )
        throw new Error('Fanvue signed DM part is unavailable');
      const reserved = await reserveFanvueDmUploadPart(database, keys, input);
      if (!reserved) throw new Error('Fanvue DM part is not eligible for dispatch');
      const etag = await client.putPart(url, bytes);
      if (
        !(await recordFanvueDmPartReceipt(database, keys, {
          ...input,
          ...reserved,
          etag,
          partNumber: input.partNumber,
        }))
      )
        throw new Error('Fanvue DM part receipt could not be persisted');
    } finally {
      bytes.fill(0);
    }
  });
}
