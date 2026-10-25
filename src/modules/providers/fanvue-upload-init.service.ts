import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withProviderStagingLock } from '../content/provider-staging-lock.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import { getFanvueJobMediaMetadata } from './fanvue-job-media-source.js';
import type { FanvueMediaUploadClient } from './fanvue-media-upload-client.js';
import {
  recordFanvueUploadSession,
  reserveFanvueUploadSession,
} from './fanvue-upload-init.repository.js';
import { createFanvueUploadSession } from './fanvue-upload-session.js';

interface InitInput {
  workspaceId: string;
  jobId: string;
  mediaId: string;
  artifactId: string;
  leaseOwner: string;
  accessToken: string;
}

function fanvueMediaType(mimeType: string): { mediaType: 'image' | 'video'; extension: string } {
  const images: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
  };
  const imageExtension = images[mimeType];
  if (imageExtension) return { mediaType: 'image', extension: imageExtension };
  if (mimeType === 'video/mp4') return { mediaType: 'video', extension: 'mp4' };
  throw new Error('Fanvue media type is unsupported');
}

/** An initialized artifact is required; a pending session is never created twice. */
export async function initializeFanvueUpload(
  database: NodePgDatabase,
  client: FanvueMediaUploadClient,
  keys: MasterKeyProvider,
  input: InitInput,
) {
  return withProviderStagingLock(database, input.artifactId, async () => {
    const media = await getFanvueJobMediaMetadata(database, input);
    const kind = fanvueMediaType(media.mimeType);
    if (!(await reserveFanvueUploadSession(database, input)))
      throw new Error('Fanvue upload session is not eligible for creation');
    const provider = await client.createSession(input.accessToken, {
      name: 'Publish Relay media',
      filename: `${input.mediaId}.${kind.extension}`,
      mediaType: kind.mediaType,
      sizeBytes: media.byteSize,
    });
    const session = createFanvueUploadSession(media.byteSize, provider);
    const credential = await recordFanvueUploadSession(database, keys, { ...input, session });
    if (!credential) throw new Error('Fanvue upload session receipt could not be persisted');
    return { ...credential, session };
  });
}
