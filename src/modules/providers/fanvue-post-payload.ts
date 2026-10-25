import { z } from 'zod';

import { fanvueContentSchema } from '../content/publication-target.js';
import type { FanvuePostInput } from './fanvue-post-client.js';

/** Map only finalized media attached to this exact job; never send local media IDs. */
export function buildFanvuePostPayload(
  content: z.input<typeof fanvueContentSchema>,
  readyMedia: ReadonlyMap<string, string>,
): FanvuePostInput {
  const post = fanvueContentSchema.parse(content);
  const mediaUuids = post.mediaIds.map((mediaId) => {
    const uuid = readyMedia.get(mediaId);
    if (!uuid || !z.uuid().safeParse(uuid).success)
      throw new Error('Fanvue post media is not provider-ready');
    return uuid;
  });
  const mediaPreviewUuid = post.mediaPreviewId ? readyMedia.get(post.mediaPreviewId) : undefined;
  if (post.mediaPreviewId && (!mediaPreviewUuid || !mediaUuids.includes(mediaPreviewUuid)))
    throw new Error('Fanvue preview media is not provider-ready');
  return {
    audience: post.audience,
    ...(post.text === undefined ? {} : { text: post.text }),
    ...(mediaUuids.length ? { mediaUuids } : {}),
    ...(mediaPreviewUuid ? { mediaPreviewUuid } : {}),
    ...(post.price === undefined ? {} : { price: post.price }),
  };
}
