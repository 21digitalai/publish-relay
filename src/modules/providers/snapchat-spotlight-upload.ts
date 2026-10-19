import { createCipheriv, randomBytes } from 'node:crypto';

import {
  snapchatSpotlightContentSchema,
  validateSnapchatSpotlightMedia,
} from './snapchat-spotlight-content.js';
import type { SnapchatSpotlightClient } from './snapchat-spotlight-client.js';

const CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_PARTS = 35;

export interface SnapchatSpotlightSource {
  open(input: { workspaceId: string; mediaId: string }): Promise<AsyncIterable<Buffer>>;
}

export async function stageAndPostSnapchatSpotlight(input: {
  client: SnapchatSpotlightClient;
  source: SnapchatSpotlightSource;
  workspaceId: string;
  profileId: string;
  accessToken: string;
  content: unknown;
  media: {
    mimeType: string;
    byteSize: number;
    durationMs: number | null;
    width: number | null;
    height: number | null;
  };
  onMediaCreated?: (mediaId: string) => Promise<void>;
  onSpotlightPosted?: (spotlightId: string) => Promise<void>;
}): Promise<{ spotlightId: string; mediaId: string }> {
  const content = snapchatSpotlightContentSchema.parse(input.content);
  validateSnapchatSpotlightMedia(input.media);
  const key = randomBytes(32);
  const iv = randomBytes(16);
  try {
    const staged = await input.client.createMedia({
      profileId: input.profileId,
      accessToken: input.accessToken,
      name: `publish-relay-${content.mediaId}`,
      key,
      iv,
    });
    await input.onMediaCreated?.(staged.mediaId);
    const source = await input.source.open({
      workspaceId: input.workspaceId,
      mediaId: content.mediaId,
    });
    await uploadEncryptedChunks(
      input.client,
      staged.addUrl,
      input.accessToken,
      source,
      key,
      iv,
      input.media.byteSize,
    );
    await input.client.finalize(staged.finalizeUrl, input.accessToken);
    const spotlightId = await input.client.post({
      profileId: input.profileId,
      accessToken: input.accessToken,
      mediaId: staged.mediaId,
      locale: content.locale,
      ...(content.description === undefined ? {} : { description: content.description }),
    });
    await input.onSpotlightPosted?.(spotlightId);
    return { spotlightId, mediaId: staged.mediaId };
  } finally {
    key.fill(0);
    iv.fill(0);
  }
}

async function uploadEncryptedChunks(
  client: SnapchatSpotlightClient,
  addUrl: string,
  accessToken: string,
  source: AsyncIterable<Buffer>,
  key: Buffer,
  iv: Buffer,
  expectedBytes: number,
): Promise<void> {
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  let pending = Buffer.alloc(0);
  let sourceBytes = 0;
  let part = 0;
  const upload = async (bytes: Buffer) => {
    part += 1;
    if (part > MAX_PARTS) throw new Error('Snapchat encrypted media exceeds multipart limit');
    await client.addChunk(addUrl, accessToken, bytes, part);
  };
  for await (const raw of source) {
    sourceBytes += raw.length;
    if (sourceBytes > expectedBytes) throw new Error('Snapchat media byte size changed');
    pending = Buffer.concat([pending, cipher.update(raw)]);
    while (pending.length >= CHUNK_BYTES) {
      await upload(pending.subarray(0, CHUNK_BYTES));
      pending = pending.subarray(CHUNK_BYTES);
    }
  }
  if (sourceBytes !== expectedBytes) throw new Error('Snapchat media byte size changed');
  pending = Buffer.concat([pending, cipher.final()]);
  if (pending.length) await upload(pending);
}
