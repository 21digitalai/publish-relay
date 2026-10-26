import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { MediaStorage } from '../content/media-storage.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import { getFanvueStagingProgress } from './fanvue-artifact.repository.js';
import type { FanvueMediaUploadClient } from './fanvue-media-upload-client.js';
import { beginFanvueMediaStaging } from './fanvue-media-staging.service.js';
import { completeFanvueUpload } from './fanvue-upload-completion.service.js';
import { uploadFanvuePart } from './fanvue-upload-part.service.js';
import { refreshFanvueUploadReadiness } from './fanvue-upload-readiness.service.js';

interface StageInput {
  workspaceId: string;
  jobId: string;
  mediaId: string;
  leaseOwner: string;
  accessToken: string;
}

export class FanvueStagingPendingError extends Error {
  constructor(public readonly phase: string) {
    super(`Fanvue staging ${phase} requires reconciliation before retry`);
  }
}

/** Resume confirmed progress only; never repeat a possibly sent provider mutation. */
export async function stageFanvueJobMedia(
  database: NodePgDatabase,
  storage: MediaStorage,
  client: FanvueMediaUploadClient,
  keys: MasterKeyProvider,
  input: StageInput,
): Promise<'ready' | 'processing'> {
  let progress = await getFanvueStagingProgress(database, keys, input);
  if (!progress || progress.phase === 'initialized') {
    await beginFanvueMediaStaging(database, client, keys, input);
    progress = await getFanvueStagingProgress(database, keys, input);
  }
  if (!progress) throw new Error('Fanvue staging artifact is unavailable');

  while (progress.phase === 'uploading' && progress.session) {
    if (!progress.credentialId || progress.credentialVersion === null)
      throw new Error('Fanvue upload session credential is unavailable');
    if (progress.session.parts.length === progress.session.partCount) {
      await completeFanvueUpload(database, client, keys, {
        ...input,
        artifactId: progress.artifactId,
        credentialId: progress.credentialId,
        credentialVersion: progress.credentialVersion,
        session: progress.session,
      });
    } else {
      await uploadFanvuePart(database, storage, client, keys, {
        ...input,
        artifactId: progress.artifactId,
        credentialId: progress.credentialId,
        credentialVersion: progress.credentialVersion,
        session: progress.session,
        partNumber: progress.session.parts.length + 1,
      });
    }
    progress = await getFanvueStagingProgress(database, keys, input);
    if (!progress) throw new Error('Fanvue staging artifact became unavailable');
  }

  if (progress.phase === 'finalized') return 'ready';
  if (progress.phase === 'processing') {
    const ready = await refreshFanvueUploadReadiness(database, client, {
      ...input,
      artifactId: progress.artifactId,
    });
    return ready ? 'ready' : 'processing';
  }
  throw new FanvueStagingPendingError(progress.phase);
}
