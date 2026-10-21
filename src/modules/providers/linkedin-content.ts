import { z } from 'zod';

export const LINKEDIN_TEXT_MAX_LENGTH = 3_000;

const linkedInTextSchema = z
  .object({
    text: z.string().trim().min(1).max(LINKEDIN_TEXT_MAX_LENGTH),
    kind: z.literal('text').optional(),
    type: z.literal('text').optional(),
  })
  .refine((content) => content.kind === 'text' || content.type === 'text');

const linkedInArticleSchema = z.object({
  kind: z.literal('link'),
  text: z.string().trim().min(1).max(LINKEDIN_TEXT_MAX_LENGTH),
  linkUrl: z.url().refine((value) => new URL(value).protocol === 'https:'),
  title: z.string().trim().min(1).max(399),
  description: z.string().trim().max(4085).optional(),
});

export type LinkedInContent =
  | { kind: 'text'; text: string }
  | {
      kind: 'link';
      text: string;
      linkUrl: string;
      title: string;
      description?: string;
      mediaId?: string;
    };

const linkedInVideoSchema = z.object({
  kind: z.literal('video'),
  text: z.string().trim().min(1).max(LINKEDIN_TEXT_MAX_LENGTH),
  title: z.string().trim().min(1).max(200),
});

const linkedInImageSchema = z.object({
  kind: z.literal('single_image'),
  text: z.string().trim().min(1).max(LINKEDIN_TEXT_MAX_LENGTH),
});
const linkedInMultiImageSchema = z.object({
  kind: z.literal('multi_image'),
  text: z.string().trim().min(1).max(LINKEDIN_TEXT_MAX_LENGTH),
});

export function parseLinkedInMultiImageContent(content: unknown, mediaIds: readonly string[]) {
  const parsed = linkedInMultiImageSchema.safeParse(content);
  if (
    !parsed.success ||
    mediaIds.length < 2 ||
    mediaIds.length > 20 ||
    mediaIds.some((id) => !id) ||
    new Set(mediaIds).size !== mediaIds.length
  )
    throw new Error('LinkedIn multi-image requires text and 2 to 20 prepared JPEG or PNG images');
  return { kind: 'multi_image' as const, text: parsed.data.text, mediaIds: [...mediaIds] };
}

export function parseLinkedInImageContent(content: unknown, mediaIds: readonly string[]) {
  const parsed = linkedInImageSchema.safeParse(content);
  if (!parsed.success || mediaIds.length !== 1 || !mediaIds[0])
    throw new Error('LinkedIn image requires text and exactly one prepared JPEG or PNG');
  return { kind: 'single_image' as const, text: parsed.data.text, mediaId: mediaIds[0] };
}

export function validateLinkedInImageAsset(media: { mimeType: string; byteSize: number }): void {
  if (
    !['image/jpeg', 'image/png'].includes(media.mimeType) ||
    media.byteSize < 1 ||
    media.byteSize > 5_000_000
  )
    throw new Error('LinkedIn image requires a JPEG or PNG up to 5 MB');
}

/** The media ID is tenant-checked by admission before this stored content is dispatched. */
export function parseLinkedInVideoContent(
  content: unknown,
  mediaIds: readonly string[],
): {
  kind: 'video';
  text: string;
  title: string;
  mediaId: string;
} {
  const parsed = linkedInVideoSchema.safeParse(content);
  if (!parsed.success || mediaIds.length !== 1 || !mediaIds[0])
    throw new Error('LinkedIn video requires text, a title, and exactly one prepared MP4');
  return { kind: 'video', text: parsed.data.text, title: parsed.data.title, mediaId: mediaIds[0] };
}

export function parseLinkedInContent(
  content: unknown,
  mediaIds: readonly string[],
): LinkedInContent {
  const article = linkedInArticleSchema.safeParse(content);
  if (article.success) {
    if (mediaIds.length > 1 || (mediaIds.length === 1 && !mediaIds[0]))
      throw new Error('LinkedIn article accepts one optional thumbnail');
    return {
      kind: 'link',
      text: article.data.text,
      linkUrl: article.data.linkUrl,
      title: article.data.title,
      ...(article.data.description === undefined ? {} : { description: article.data.description }),
      ...(mediaIds[0] ? { mediaId: mediaIds[0] } : {}),
    };
  }
  if (mediaIds.length !== 0) throw new Error('LinkedIn text posts do not accept media');
  const text = linkedInTextSchema.safeParse(content);
  if (text.success) return { kind: 'text', text: text.data.text };
  throw new Error('LinkedIn requires text up to 3000 characters or an HTTPS article with a title');
}

export function validateLinkedInTextContent(content: unknown, mediaIds: readonly string[]): void {
  if (mediaIds.length !== 0 || !linkedInTextSchema.safeParse(content).success)
    throw new Error('LinkedIn member posts require text only, up to 3000 characters');
}

/** Conservative member-feed bounds from the Videos API and linked video specifications. */
export function validateLinkedInVideoAsset(media: {
  mimeType: string;
  byteSize: number;
  durationMs: number | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
}): void {
  if (media.mimeType !== 'video/mp4' || media.container !== 'mp4')
    throw new Error('LinkedIn video requires an MP4 file');
  if (media.byteSize < 75_000 || media.byteSize > 500_000_000)
    throw new Error('LinkedIn video must be between 75 kB and 500 MB');
  if (media.durationMs === null || media.durationMs < 3_000 || media.durationMs > 1_800_000)
    throw new Error('LinkedIn video must be between 3 seconds and 30 minutes');
  if (media.videoCodec !== 'h264' && media.videoCodec !== 'vp8')
    throw new Error('LinkedIn video requires H.264 or VP8 video codec');
  if (media.audioCodec !== null && media.audioCodec !== 'aac' && media.audioCodec !== 'mp4a')
    throw new Error('LinkedIn video audio requires AAC or MPEG-4 codec');
}
