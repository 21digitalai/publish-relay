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
