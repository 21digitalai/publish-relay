import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withProviderStagingLock } from '../content/provider-staging-lock.js';
import type { MediaStorage } from '../content/media-storage.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import { openFanvueJobMediaRange } from './fanvue-job-media-source.js';
import type { FanvueMediaUploadClient } from './fanvue-media-upload-client.js';
import { fanvuePartRange } from './fanvue-media-upload-plan.js';
import {
  advanceFanvueUploadProgress,
  reserveFanvueUploadPart,
} from './fanvue-upload-progress.repository.js';
import type { FanvueUploadSession } from './fanvue-upload-session.js';

interface UploadPartInput {
  workspaceId: string;
  jobId: string;
  mediaId: string;
  artifactId: string;
  leaseOwner: string;
  credentialId: string;
  credentialVersion: number;
  session: FanvueUploadSession;
  partNumber: number;
  accessToken: string;
}

async function readExactPart(stream: NodeJS.ReadableStream, byteLength: number): Promise<Buffer> {
  const part = Buffer.allocUnsafe(byteLength);
  let total = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (total + bytes.length > byteLength)
        throw new Error('Fanvue media range exceeded the expected part size');
      bytes.copy(part, total);
      total += bytes.length;
    }
    if (total !== byteLength)
      throw new Error('Fanvue media range ended before the expected part size');
    return part;
  } catch (error) {
    part.fill(0);
    throw error;
  }
}

/** Upload exactly one part. Any possibly sent PUT remains put_pending until explicit reconciliation. */
export async function uploadFanvuePart(
  database: NodePgDatabase,
  storage: MediaStorage,
  client: FanvueMediaUploadClient,
  keys: MasterKeyProvider,
  input: UploadPartInput,
): Promise<void> {
  await withProviderStagingLock(database, input.artifactId, async () => {
    const range = fanvuePartRange(input.session, input.partNumber);
    const media = await openFanvueJobMediaRange(database, storage, {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      mediaId: input.mediaId,
      leaseOwner: input.leaseOwner,
      start: range.start,
      end: range.end,
    });
    if (media.byteSize !== input.session.byteSize)
      throw new Error('Fanvue upload session does not match the media size');
    const bytes = await readExactPart(media.stream, range.byteLength);
    try {
      const signed = await client.signParts(
        input.accessToken,
        input.session.uploadId,
        input.partNumber,
        input.partNumber,
      );
      const url = signed.parts[0]?.url;
      if (
        signed.partSize !== input.session.partSize ||
        !url ||
        signed.parts[0]?.partNumber !== input.partNumber
      )
        throw new Error('Fanvue signed upload part is unavailable');
      const reserved = await reserveFanvueUploadPart(database, keys, input);
      if (!reserved) throw new Error('Fanvue upload part is not eligible for dispatch');
      const etag = await client.putPart(url, bytes);
      const advanced = await advanceFanvueUploadProgress(database, keys, { ...input, etag });
      if (!advanced) throw new Error('Fanvue upload part receipt could not be persisted');
    } finally {
      bytes.fill(0);
    }
  });
}
