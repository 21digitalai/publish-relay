import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import { reserveFanvueStagingArtifact } from './fanvue-artifact.repository.js';
import { getFanvueJobMediaMetadata } from './fanvue-job-media-source.js';
import type { FanvueMediaUploadClient } from './fanvue-media-upload-client.js';
import { initializeFanvueUpload } from './fanvue-upload-init.service.js';

const FANVUE_UPLOAD_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

interface StagingInput {
  workspaceId: string;
  jobId: string;
  mediaId: string;
  leaseOwner: string;
  accessToken: string;
  now?: Date;
}

/** Reserve one canonical job/media artifact before any Fanvue session creation. */
export async function beginFanvueMediaStaging(
  database: NodePgDatabase,
  client: FanvueMediaUploadClient,
  keys: MasterKeyProvider,
  input: StagingInput,
) {
  await getFanvueJobMediaMetadata(database, input);
  const now = input.now ?? new Date();
  const artifactId = await reserveFanvueStagingArtifact(database, {
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    mediaId: input.mediaId,
    leaseOwner: input.leaseOwner,
    expiresAt: new Date(now.getTime() + FANVUE_UPLOAD_SESSION_LIFETIME_MS),
  });
  if (!artifactId) throw new Error('Fanvue staging artifact is not eligible for reservation');
  return initializeFanvueUpload(database, client, keys, { ...input, artifactId });
}
