import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withProviderStagingLock } from '../content/provider-staging-lock.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import {
  fanvueCompletionStatusSchema,
  type FanvueMediaUploadClient,
} from './fanvue-media-upload-client.js';
import {
  confirmFanvueUploadCompletion,
  reserveFanvueUploadCompletion,
} from './fanvue-upload-progress.repository.js';
import { parseFanvueUploadSession, type FanvueUploadSession } from './fanvue-upload-session.js';

interface CompletionInput {
  workspaceId: string;
  jobId: string;
  mediaId: string;
  artifactId: string;
  leaseOwner: string;
  credentialId: string;
  credentialVersion: number;
  session: FanvueUploadSession;
  accessToken: string;
}

/** A possibly sent PATCH stays complete_pending; it is never repeated automatically. */
export async function completeFanvueUpload(
  database: NodePgDatabase,
  client: FanvueMediaUploadClient,
  keys: MasterKeyProvider,
  input: CompletionInput,
): Promise<void> {
  await withProviderStagingLock(database, input.artifactId, async () => {
    const session = parseFanvueUploadSession(input.session);
    if (session.parts.length !== session.partCount)
      throw new Error('Fanvue upload parts are incomplete');
    if (!(await reserveFanvueUploadCompletion(database, keys, input)))
      throw new Error('Fanvue upload completion is not eligible for dispatch');
    const response = await client.completeSession(
      input.accessToken,
      session.uploadId,
      session.parts,
    );
    if (!fanvueCompletionStatusSchema.safeParse(response.status).success)
      throw new Error('Fanvue upload completion was not confirmed');
    if (!(await confirmFanvueUploadCompletion(database, keys, input)))
      throw new Error('Fanvue upload completion could not be persisted');
  });
}
