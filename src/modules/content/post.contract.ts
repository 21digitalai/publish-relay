import { z } from 'zod';

export const createPostRequestSchema = z.object({
  content: z.record(z.string(), z.unknown()),
  mediaIds: z.array(z.uuid()).max(10).default([]),
  providerAccountIds: z.array(z.uuid()).min(1).max(50),
  scheduledAt: z.iso.datetime(),
});

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
  effectiveProviderSettings: z.record(z.string(), z.unknown()).nullable(),
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
