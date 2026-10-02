import { z } from 'zod';

import type { DestinationProvider } from '../providers/contract.js';
import {
  TIKTOK_CAPTION_MAX_LENGTH,
  tiktokCommercialContentSchema,
} from '../providers/tiktok-publication-options.js';

const accountId = z.uuid();
const mediaId = z.uuid();
const version = z.literal(1);

const xContent = z.object({
  schemaVersion: version,
  kind: z.enum(['text', 'quote', 'article', 'thread']),
  text: z.string().optional(),
  quotedPostId: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  parts: z.array(z.unknown()).optional(),
  posts: z
    .array(z.union([z.string(), z.object({ text: z.string(), mediaIds: z.array(mediaId) })]))
    .refine(
      (posts) => posts.every((part) => typeof part === typeof posts[0]),
      'X thread parts must use one consistent shape',
    )
    .optional(),
  mediaIds: z.array(mediaId).max(10).default([]),
});

const youtubeContent = z.object({
  schemaVersion: version,
  kind: z.literal('video'),
  text: z.string().default(''),
  mediaId,
  providerOptions: z.object({ youtube: z.record(z.string(), z.unknown()) }),
});

const tiktokContent = z.object({
  schemaVersion: version,
  kind: z.literal('video'),
  caption: z.string().max(TIKTOK_CAPTION_MAX_LENGTH),
  mediaId,
  options: z.object({
    privacyLevel: z.enum([
      'PUBLIC_TO_EVERYONE',
      'MUTUAL_FOLLOW_FRIENDS',
      'FOLLOWER_OF_CREATOR',
      'SELF_ONLY',
    ]),
    allowComment: z.boolean(),
    allowDuet: z.boolean(),
    allowStitch: z.boolean(),
    coverTimestampMs: z.number().int().nonnegative().optional(),
    commercialContent: tiktokCommercialContentSchema,
    aiGenerated: z.boolean(),
  }),
  capabilitySnapshotId: accountId,
  consentReceiptId: accountId,
});

const metaContent = z.object({
  schemaVersion: version,
  kind: z.enum(['single_image', 'carousel', 'link']),
  text: z.string().optional(),
  linkUrl: z.url().optional(),
  mediaIds: z.array(mediaId).max(10).default([]),
});

const linkedinContent = z.object({
  schemaVersion: version,
  kind: z.literal('text'),
  text: z.string().min(1),
});

export const publicationTargetSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('x'), providerAccountId: accountId, content: xContent }),
  z.object({
    provider: z.literal('youtube'),
    providerAccountId: accountId,
    content: youtubeContent,
  }),
  z.object({ provider: z.literal('tiktok'), providerAccountId: accountId, content: tiktokContent }),
  z.object({
    provider: z.literal('instagram'),
    providerAccountId: accountId,
    content: metaContent,
  }),
  z.object({
    provider: z.literal('facebook_page'),
    providerAccountId: accountId,
    content: metaContent,
  }),
  z.object({
    provider: z.literal('linkedin'),
    providerAccountId: accountId,
    content: linkedinContent,
  }),
]);

export type PublicationTarget = z.infer<typeof publicationTargetSchema>;

export interface NormalizedPublicationTarget {
  provider: DestinationProvider | 'tiktok';
  providerAccountId: string;
  content: Record<string, unknown>;
  mediaIds: string[];
}

export function normalizePublicationTarget(target: PublicationTarget): NormalizedPublicationTarget {
  const content = target.content;
  if (target.provider === 'youtube' || target.provider === 'tiktok') {
    const mediaId = target.content.mediaId;
    return {
      provider: target.provider,
      providerAccountId: target.providerAccountId,
      content: { ...content, mediaIds: [mediaId] },
      mediaIds: [mediaId],
    };
  }
  return {
    provider: target.provider,
    providerAccountId: target.providerAccountId,
    content,
    mediaIds: 'mediaIds' in content ? [...content.mediaIds] : [],
  };
}
