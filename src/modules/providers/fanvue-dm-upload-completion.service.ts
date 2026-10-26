import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withProviderStagingLock } from '../content/provider-staging-lock.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import type { DmUploadKey } from './fanvue-dm-upload-init.repository.js';
import { loadFanvueDmUploadSession } from './fanvue-dm-upload-source.js';
import {
  confirmFanvueDmCompletion,
  reserveFanvueDmCompletion,
} from './fanvue-dm-upload-completion.repository.js';
import {
  fanvueCompletionStatusSchema,
  type FanvueMediaUploadClient,
} from './fanvue-media-upload-client.js';

/** One completion PATCH after all receipts; a lost response remains unknown. */
export async function completeFanvueDmUpload(
  database: NodePgDatabase,
  client: FanvueMediaUploadClient,
  keys: MasterKeyProvider,
  input: DmUploadKey & { accessToken: string },
): Promise<void> {
  const lockKey = `${input.workspaceId}:${input.accountId}:${input.clientActionId}:${input.mediaId}`;
  await withProviderStagingLock(database, lockKey, async () => {
    if (!input.accessToken) throw new Error('Selected Fanvue creator token is required');
    const { session, credentialVersion } = await loadFanvueDmUploadSession(database, keys, input);
    if (session.parts.length !== session.partCount)
      throw new Error('Fanvue DM upload parts are incomplete');
    const receipt = { ...input, session, credentialVersion };
    if (!(await reserveFanvueDmCompletion(database, receipt)))
      throw new Error('Fanvue DM completion is not eligible for dispatch');
    const response = await client.completeSession(
      input.accessToken,
      session.uploadId,
      session.parts,
    );
    if (!fanvueCompletionStatusSchema.safeParse(response.status).success)
      throw new Error('Fanvue DM completion was not confirmed');
    if (!(await confirmFanvueDmCompletion(database, receipt)))
      throw new Error('Fanvue DM completion receipt could not be persisted');
  });
}
