import { z } from 'zod';

export const snapchatSpotlightContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('spotlight_video'),
  mediaId: z.uuid(),
  locale: z.string().regex(/^[a-z]{2}_[A-Z]{2}$/),
  description: z.string().max(160).optional(),
});

export function validateSnapchatSpotlightMedia(media: {
  mimeType: string;
  byteSize: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}): void {
  if (
    media.mimeType !== 'video/mp4' ||
    !Number.isSafeInteger(media.byteSize) ||
    media.byteSize <= 0 ||
    media.byteSize > 1_000_000_000 ||
    media.durationMs === null ||
    media.durationMs < 6_000 ||
    media.durationMs > 60_000 ||
    media.width === null ||
    media.width < 540 ||
    media.height === null ||
    media.height < 960
  )
    throw new Error(
      'Snapchat Spotlight requires MP4, 6–60 seconds, at least 540x960 and at most 1 GB',
    );
}
