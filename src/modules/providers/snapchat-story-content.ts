import { z } from 'zod';

// Fixture-only target. No generic create or production worker registration admits Story.
export const snapchatStoryContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.enum(['story_image', 'story_video']),
  mediaId: z.uuid(),
  customizedTtl: z.enum(['ONE_DAY', 'TWO_DAYS', 'THREE_DAYS', 'ONE_WEEK']).optional(),
  link: z
    .url()
    .refine((value) => /^https?:\/\//.test(value))
    .optional(),
});

export function validateSnapchatStoryMedia(
  kind: 'story_image' | 'story_video',
  media: {
    mimeType: string;
    byteSize: number;
    durationMs: number | null;
    width: number | null;
    height: number | null;
  },
): void {
  if (
    !Number.isSafeInteger(media.byteSize) ||
    media.byteSize <= 0 ||
    media.byteSize > 1_000_000_000
  )
    throw new Error('Snapchat Story media must be no larger than 1 GB');
  if (kind === 'story_image') {
    if (!['image/jpeg', 'image/png'].includes(media.mimeType))
      throw new Error('Snapchat Story image must be JPEG or PNG');
    return;
  }
  if (
    media.mimeType !== 'video/mp4' ||
    media.durationMs === null ||
    media.durationMs < 5_000 ||
    media.durationMs > 60_000 ||
    media.width === null ||
    media.width < 540 ||
    media.height === null ||
    media.height < 960
  )
    throw new Error('Snapchat Story video requires MP4, 5–60 seconds and at least 540x960');
}
