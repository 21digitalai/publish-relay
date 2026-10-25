import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { MediaStorage } from '../content/media-storage.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import {
  bindFanvueDmAttachment,
  getFanvueDmAttachmentState,
} from './fanvue-dm-attachment.repository.js';
import { completeFanvueDmUpload } from './fanvue-dm-upload-completion.service.js';
import type { DmUploadKey } from './fanvue-dm-upload-init.repository.js';
import { initializeFanvueDmUpload } from './fanvue-dm-upload-init.service.js';
import { uploadFanvueDmPart } from './fanvue-dm-upload-part.service.js';
import { refreshFanvueDmReadiness } from './fanvue-dm-upload-readiness.service.js';
import { loadFanvueDmUploadSession } from './fanvue-dm-upload-source.js';
import type { FanvueMediaUploadClient } from './fanvue-media-upload-client.js';
import type { FanvueReadService } from './fanvue-read.service.js';

/** Advance one durable DM upload phase; each request makes at most one provider media call. */
export async function stageFanvueDmMediaStep(
  database: NodePgDatabase,
  storage: MediaStorage,
  client: FanvueMediaUploadClient,
  keys: MasterKeyProvider,
  reads: Pick<FanvueReadService, 'getDmMediaUploadToken'>,
  input: DmUploadKey,
): Promise<'uploading' | 'processing' | 'ready' | 'unknown' | 'failed'> {
  const accessToken = await reads.getDmMediaUploadToken(input);
  if (!(await bindFanvueDmAttachment(database, input)))
    throw new Error('Fanvue DM media cannot be bound to this account');
  const state = await getFanvueDmAttachmentState(database, input);
  if (state === 'bound') {
    await initializeFanvueDmUpload(database, client, keys, { ...input, accessToken });
    return 'uploading';
  }
  if (state === 'uploading') {
    const { session } = await loadFanvueDmUploadSession(database, keys, input);
    if (session.parts.length < session.partCount) {
      await uploadFanvueDmPart(database, storage, client, keys, {
        ...input,
        partNumber: session.parts.length + 1,
        accessToken,
      });
      return 'uploading';
    }
    await completeFanvueDmUpload(database, client, keys, { ...input, accessToken });
    return 'processing';
  }
  if (state === 'processing') {
    const ready = await refreshFanvueDmReadiness(database, client, { ...input, accessToken });
    return ready ? 'ready' : 'processing';
  }
  if (state === 'ready' || state === 'unknown' || state === 'failed') return state;
  throw new Error('Fanvue DM attachment is unavailable');
}
