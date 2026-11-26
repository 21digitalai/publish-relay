import { z } from 'zod';
import {
  normalizePublicationTarget,
  publicationTargetSchema,
  type NormalizedPublicationTarget,
} from './publication-target.js';

export const legacyCreatePostRequestSchema = z.object({
  destination: z.never().optional(),
  content: z.record(z.string(), z.unknown()),
  mediaIds: z.array(z.uuid()).max(20).default([]),
  providerAccountIds: z.array(z.uuid()).min(1).max(50),
  scheduledAt: z.iso.datetime(),
  approvalRequired: z.boolean().optional(),
});

const targetOptions = publicationTargetSchema.options;
// Preserve each option's literal provider/content pairing in the generated request union.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function destinationRequestFor<T extends (typeof targetOptions)[number]>(target: T) {
  return z.object({
    destination: target.pick({ provider: true, providerAccountId: true }),
    content: target.shape.content,
    providerAccountIds: z.never().optional(),
    scheduledAt: z.iso.datetime(),
    approvalRequired: z.boolean().optional(),
  });
}

export const destinationCreatePostRequestSchema = z.union([
  destinationRequestFor(targetOptions[0]),
  destinationRequestFor(targetOptions[1]),
  destinationRequestFor(targetOptions[2]),
  destinationRequestFor(targetOptions[3]),
  destinationRequestFor(targetOptions[4]),
  destinationRequestFor(targetOptions[5]),
  destinationRequestFor(targetOptions[6]),
]);

export const createPostRequestSchema = z.union([
  destinationCreatePostRequestSchema,
  legacyCreatePostRequestSchema,
]);

export const postValidationRequestSchema = z.intersection(
  createPostRequestSchema,
  z.object({
    validationPreview: z
      .object({ xMediaPresent: z.literal(true) })
      .strict()
      .optional(),
  }),
);

export function normalizeCreatePostRequest(request: z.infer<typeof createPostRequestSchema>): {
  content: Record<string, unknown>;
  mediaIds: string[];
  providerAccountIds: string[];
  selectedDestination?: NormalizedPublicationTarget['provider'];
  approvalRequired?: boolean;
} {
  if (!('destination' in request)) {
    return {
      content: request.content,
      mediaIds: request.mediaIds,
      providerAccountIds: request.providerAccountIds,
      ...(request.approvalRequired !== undefined
        ? { approvalRequired: request.approvalRequired }
        : {}),
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
    ...(request.approvalRequired !== undefined
      ? { approvalRequired: request.approvalRequired }
      : {}),
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

export const postValidationResponseSchema = z.object({
  valid: z.boolean(),
  mediaNotValidated: z.literal(true).optional(),
  destinations: z
    .array(
      z.object({
        providerAccountId: z.uuid(),
        valid: z.boolean(),
        error: z.string().optional(),
        weightedLength: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().optional(),
      }),
    )
    .max(50),
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
  approvalRequired: z.boolean(),
  approvalStatus: z.enum(['not_required', 'awaiting_approval', 'approved']),
  scheduledAt: timestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  effectivePayload: z.record(z.string(), z.unknown()).nullable(),
  effectiveProviderSettings: z.record(z.string(), z.unknown()).nullable(),
  links: z.object({ self: z.string(), post: z.string() }),
});

export const jobCollectionResponseSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.uuid(),
        postId: z.uuid(),
        state: z.string(),
        approvalRequired: z.boolean(),
        approvalStatus: z.enum(['not_required', 'awaiting_approval', 'approved']),
        scheduledAt: timestampSchema,
        updatedAt: timestampSchema,
        destination: z.object({ id: z.uuid(), displayName: z.string(), provider: z.string() }),
        links: z.object({ self: z.string(), post: z.string() }),
      }),
    )
    .max(100),
  nextCursor: z.string().nullable(),
});

export const postDetailResponseSchema = postSummarySchema.extend({
  revisionId: z.uuid(),
  revisionNumber: z.number().int().positive(),
  jobs: z.array(
    z.object({
      id: z.uuid(),
      state: z.string(),
      approvalRequired: z.boolean(),
      approvalStatus: z.enum(['not_required', 'awaiting_approval', 'approved']),
      scheduledAt: timestampSchema,
      links: z.object({ self: z.string() }),
    }),
  ),
});

export const replacePostMediaSchema = z.strictObject({
  expectedRevisionId: z.uuid(),
  replacements: z
    .array(z.strictObject({ oldMediaId: z.uuid(), newMediaId: z.uuid() }))
    .min(1)
    .max(100),
});

export const replacePostMediaResponseSchema = z.object({
  postId: z.uuid(),
  revisionId: z.uuid(),
  jobIds: z.array(z.uuid()).max(100),
});
