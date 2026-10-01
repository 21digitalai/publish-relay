import { z } from 'zod';

export interface YouTubeVideoOptions {
  schemaVersion: 1;
  title: string;
  description?: string;
  privacyStatus: 'public' | 'unlisted' | 'private';
  madeForKids: boolean;
  notifySubscribers: boolean;
  tags?: string[];
  categoryId?: string;
}

const privacyStatusSchema = z.enum(['public', 'unlisted', 'private']);

export const youtubeDestinationDefaultsSchema = z
  .object({
    privacyStatus: privacyStatusSchema.optional(),
    madeForKids: z.boolean().optional(),
    notifySubscribers: z.boolean().optional(),
    tags: z.array(z.string().min(1)).optional(),
    categoryId: z.string().min(1).optional(),
  })
  .strict();

const youtubeRequestOptionsSchema = youtubeDestinationDefaultsSchema.extend({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1),
  description: z.string().optional(),
});

export function resolveYouTubeSettings(
  defaultsInput: unknown,
  requestInput: unknown,
): YouTubeVideoOptions {
  const defaults = youtubeDestinationDefaultsSchema.parse(defaultsInput ?? {});
  const request = youtubeRequestOptionsSchema.parse(requestInput);
  const madeForKids = request.madeForKids ?? defaults.madeForKids;
  if (madeForKids === undefined) {
    throw new Error('YouTube madeForKids requires a destination default or request override');
  }
  const tags = request.tags ?? defaults.tags;
  const categoryId = request.categoryId ?? defaults.categoryId;
  return {
    schemaVersion: 1,
    title: request.title,
    ...(request.description !== undefined ? { description: request.description } : {}),
    privacyStatus: request.privacyStatus ?? defaults.privacyStatus ?? 'public',
    madeForKids,
    notifySubscribers: request.notifySubscribers ?? defaults.notifySubscribers ?? false,
    ...(tags !== undefined ? { tags } : {}),
    ...(categoryId !== undefined ? { categoryId } : {}),
  };
}
