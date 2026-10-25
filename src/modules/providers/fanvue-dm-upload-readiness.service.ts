import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withProviderStagingLock } from '../content/provider-staging-lock.js';
import type { DmUploadKey } from './fanvue-dm-upload-init.repository.js';
import {
  getFanvueDmProcessingUuid,
  settleFanvueDmReadiness,
} from './fanvue-dm-upload-readiness.repository.js';
import type { FanvueMediaUploadClient } from './fanvue-media-upload-client.js';

/** Provider status is authoritative; only an exact ready response promotes this attachment. */
export async function refreshFanvueDmReadiness(
  database: NodePgDatabase,
  client: FanvueMediaUploadClient,
  input: DmUploadKey & { accessToken: string },
): Promise<boolean> {
  const lockKey = `${input.workspaceId}:${input.accountId}:${input.clientActionId}:${input.mediaId}`;
  return withProviderStagingLock(database, lockKey, async () => {
    if (!input.accessToken) throw new Error('Selected Fanvue creator token is required');
    const mediaUuid = await getFanvueDmProcessingUuid(database, input);
    if (!mediaUuid) throw new Error('Fanvue DM processing attachment is unavailable');
    const status = await client.getStatus(input.accessToken, mediaUuid);
    if (status.uuid !== mediaUuid) throw new Error('Fanvue DM media status identity mismatch');
    if (status.status === 'error') {
      if (!(await settleFanvueDmReadiness(database, { ...input, mediaUuid, state: 'failed' })))
        throw new Error('Fanvue DM failure receipt could not be persisted');
      throw new Error('Fanvue DM media processing failed');
    }
    if (status.status !== 'ready') return false;
    if (!(await settleFanvueDmReadiness(database, { ...input, mediaUuid, state: 'ready' })))
      throw new Error('Fanvue DM media readiness could not be persisted');
    return true;
  });
}
