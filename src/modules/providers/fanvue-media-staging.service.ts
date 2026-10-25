import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { createStagingArtifact } from '../content/provider-staging.repository.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
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
  const artifact = await withTenantTransaction(database, input, (transaction) =>
    createStagingArtifact(transaction, {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      mediaId: input.mediaId,
      providerReference: 'fanvue:multipart',
      expiresAt: new Date(now.getTime() + FANVUE_UPLOAD_SESSION_LIFETIME_MS),
    }),
  );
  if (artifact.providerReference !== 'fanvue:multipart')
    throw new Error('Existing media staging artifact belongs to another provider');
  return initializeFanvueUpload(database, client, keys, { ...input, artifactId: artifact.id });
}
