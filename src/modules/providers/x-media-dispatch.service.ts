import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { XHttpClient, type XHttpClientOptions } from './x-http-client.js';
import {
  stageXMedia,
  type XMediaSource,
  type XMediaUploadClient,
} from './x-media-staging.service.js';

export interface XMediaDispatchInput {
  workspaceId: string;
  jobId: string;
  credential: string;
  mediaIds: readonly string[];
  idempotencyKey: string;
}

export type XMediaClientFactory = (credential: string) => XMediaUploadClient;

export function createXMediaClientFactory(
  options: Pick<XHttpClientOptions, 'consumerKey' | 'consumerSecret'>,
): XMediaClientFactory {
  return (credential) => new XHttpClient(options).bindCredential(credential);
}

export async function stageXJobMedia(
  database: NodePgDatabase,
  source: XMediaSource,
  createClient: XMediaClientFactory,
  input: XMediaDispatchInput,
): Promise<{ mediaIds: string[]; state: 'succeeded' | 'pending' }> {
  const client = createClient(input.credential);
  const staged = [];
  for (const mediaId of input.mediaIds) {
    staged.push(
      await stageXMedia(database, source, client, {
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        mediaId,
        idempotencyKey: `${input.idempotencyKey}:${mediaId}`,
      }),
    );
  }
  return {
    mediaIds: staged.map((media) => media.mediaId),
    state: staged.some((media) => media.state === 'pending') ? 'pending' : 'succeeded',
  };
}
