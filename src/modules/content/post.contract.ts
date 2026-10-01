import { z } from 'zod';
import {
  normalizePublicationTarget,
  publicationTargetSchema,
  type NormalizedPublicationTarget,
} from './publication-target.js';

export const legacyCreatePostRequestSchema = z.object({
  content: z.record(z.string(), z.unknown()),
  mediaIds: z.array(z.uuid()).max(10).default([]),
  providerAccountIds: z.array(z.uuid()).min(1).max(50),
  scheduledAt: z.iso.datetime(),
});

export const destinationCreatePostRequestSchema = z.object({
  destination: z.object({ provider: z.string(), providerAccountId: z.uuid() }),
  content: z.record(z.string(), z.unknown()),
  scheduledAt: z.iso.datetime(),
});

export const createPostRequestSchema = z.union([
  destinationCreatePostRequestSchema,
  legacyCreatePostRequestSchema,
]);

export function normalizeCreatePostRequest(request: z.infer<typeof createPostRequestSchema>): {
  content: Record<string, unknown>;
  mediaIds: string[];
  providerAccountIds: string[];
  selectedDestination?: NormalizedPublicationTarget['provider'];
} {
  if (!('destination' in request)) {
    return {
      content: request.content,
      mediaIds: request.mediaIds,
      providerAccountIds: request.providerAccountIds,
    };
  }
  const target = publicationTargetSchema.parse({
    ...request.destination,
    content: request.content,
  });
  const normalized = normalizePublicationTarget(target);
  return {
    content: normalized.content,
    mediaIds: normalized.mediaIds,
    providerAccountIds: [normalized.providerAccountId],
    selectedDestination: normalized.provider,
  };
}

export const postMutationResponseSchema = z.object({
  id: z.uuid(),
  revisionId: z.uuid(),
  links: z.object({
    self: z.string().regex(/^\/api\/v1\/posts\/[0-9a-f-]+$/),
    jobs: z.array(z.string().regex(/^\/api\/v1\/jobs\/[0-9a-f-]+$/)).max(50),
  }),
});

const timestampSchema = z.iso.datetime();
const postSummarySchema = z.object({
  id: z.uuid(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  links: z.object({ self: z.string() }),
});

export const postCollectionResponseSchema = z.object({
  items: z.array(postSummarySchema).max(100),
  nextCursor: z.string().nullable(),
});

export const jobDetailResponseSchema = z.object({
  id: z.uuid(),
  postId: z.uuid(),
  revisionId: z.uuid(),
  state: z.string(),
  scheduledAt: timestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  effectivePayload: z.record(z.string(), z.unknown()).nullable(),
  effectiveProviderSettings: z.record(z.string(), z.unknown()).nullable(),
  links: z.object({ self: z.string(), post: z.string() }),
});

export const postDetailResponseSchema = postSummarySchema.extend({
  revisionId: z.uuid(),
  revisionNumber: z.number().int().positive(),
  jobs: z.array(
    z.object({
      id: z.uuid(),
      state: z.string(),
      scheduledAt: timestampSchema,
      links: z.object({ self: z.string() }),
    }),
  ),
});
