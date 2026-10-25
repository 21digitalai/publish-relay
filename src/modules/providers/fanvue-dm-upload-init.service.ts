import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import {
  getBoundFanvueDmMedia,
  recordFanvueDmSession,
  reserveFanvueDmSession,
  type DmUploadKey,
} from './fanvue-dm-upload-init.repository.js';
import type { FanvueMediaUploadClient } from './fanvue-media-upload-client.js';
import { fanvueMediaType } from './fanvue-upload-init.service.js';
import { createFanvueUploadSession } from './fanvue-upload-session.js';

const MAX_FANVUE_DM_UPLOAD_BYTES = 1_610_612_736;

/** Internal boundary only: caller must obtain the selected creator token under chat/media consent. */
export async function initializeFanvueDmUpload(
  database: NodePgDatabase,
  client: FanvueMediaUploadClient,
  keys: MasterKeyProvider,
  input: DmUploadKey & { accessToken: string },
) {
  const media = await getBoundFanvueDmMedia(database, input);
  if (!media) throw new Error('Fanvue DM attachment is not ready for upload');
  const kind = fanvueMediaType(media.mimeType);
  if (media.byteSize < 1 || media.byteSize > MAX_FANVUE_DM_UPLOAD_BYTES)
    throw new Error('Fanvue DM media exceeds the provider size limit');
  if (!input.accessToken) throw new Error('Selected Fanvue creator token is required');
  if (!(await reserveFanvueDmSession(database, input)))
    throw new Error('Fanvue DM upload session is already pending');
  const provider = await client.createSession(input.accessToken, {
    name: 'Publish Relay DM media',
    filename: `${input.mediaId}.${kind.extension}`,
    mediaType: kind.mediaType,
    sizeBytes: media.byteSize,
  });
  const session = createFanvueUploadSession(media.byteSize, provider);
  if (!(await recordFanvueDmSession(database, keys, { ...input, session })))
    throw new Error('Fanvue DM upload session receipt could not be persisted');
  return { state: 'uploading' as const, mediaUuid: session.mediaUuid };
}
