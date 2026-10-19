import { randomBytes } from 'node:crypto';

import {
  snapchatStoryContentSchema,
  validateSnapchatStoryMedia,
} from './snapchat-story-content.js';
import type { SnapchatStoryClient } from './snapchat-story-client.js';
import {
  uploadEncryptedChunks,
  type SnapchatSpotlightSource,
} from './snapchat-spotlight-upload.js';

export async function stageAndPostSnapchatStory(input: {
  client: SnapchatStoryClient;
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
  onBeforeStoryPost?: () => Promise<void>;
  onStoryPosted?: (requestId: string) => Promise<void>;
}): Promise<{ requestId: string; mediaId: string }> {
  const content = snapchatStoryContentSchema.parse(input.content);
  validateSnapchatStoryMedia(content.kind, input.media);
  const key = randomBytes(32);
  const iv = randomBytes(16);
  try {
    const staged = await input.client.createMedia({
      profileId: input.profileId,
      accessToken: input.accessToken,
      name: `publish-relay-${content.mediaId}`,
      mediaType: content.kind === 'story_image' ? 'IMAGE' : 'VIDEO',
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
    await input.onBeforeStoryPost?.();
    const requestId = await input.client.postStory({
      profileId: input.profileId,
      accessToken: input.accessToken,
      mediaId: staged.mediaId,
      ...(content.customizedTtl ? { customizedTtl: content.customizedTtl } : {}),
      ...(content.link ? { link: content.link } : {}),
    });
    await input.onStoryPosted?.(requestId);
    return { requestId, mediaId: staged.mediaId };
  } finally {
    key.fill(0);
    iv.fill(0);
  }
}
