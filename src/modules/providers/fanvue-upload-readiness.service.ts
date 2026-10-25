import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withProviderStagingLock } from '../content/provider-staging-lock.js';
import type { FanvueMediaUploadClient } from './fanvue-media-upload-client.js';
import { getFanvueJobMediaMetadata } from './fanvue-job-media-source.js';
import {
  getFanvueProcessingMediaUuid,
  markFanvueUploadReady,
} from './fanvue-upload-progress.repository.js';

interface ReadinessInput {
  workspaceId: string;
  jobId: string;
  mediaId: string;
  artifactId: string;
  leaseOwner: string;
  accessToken: string;
}

export async function refreshFanvueUploadReadiness(
  database: NodePgDatabase,
  client: FanvueMediaUploadClient,
  input: ReadinessInput,
): Promise<boolean> {
  return withProviderStagingLock(database, input.artifactId, async () => {
    const mediaUuid = await getFanvueProcessingMediaUuid(database, input);
    if (!mediaUuid) throw new Error('Fanvue processing artifact is unavailable');
    await getFanvueJobMediaMetadata(database, input);
    const status = await client.getStatus(input.accessToken, mediaUuid);
    if (status.uuid !== mediaUuid) throw new Error('Fanvue media status identity mismatch');
    if (status.status === 'error') throw new Error('Fanvue media processing failed');
    if (status.status !== 'ready') return false;
    if (
      !(await markFanvueUploadReady(database, {
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        mediaId: input.mediaId,
        artifactId: input.artifactId,
        leaseOwner: input.leaseOwner,
        mediaUuid: status.uuid,
      }))
    )
      throw new Error('Fanvue media readiness could not be persisted');
    return true;
  });
}
