import { z } from 'zod';

export const LINKEDIN_TEXT_MAX_LENGTH = 3_000;

const linkedInTextSchema = z
  .object({
    text: z.string().trim().min(1).max(LINKEDIN_TEXT_MAX_LENGTH),
    kind: z.literal('text').optional(),
    type: z.literal('text').optional(),
  })
  .refine((content) => content.kind === 'text' || content.type === 'text');

export function validateLinkedInTextContent(content: unknown, mediaIds: readonly string[]): void {
  if (mediaIds.length !== 0 || !linkedInTextSchema.safeParse(content).success)
    throw new Error('LinkedIn member posts require text only, up to 3000 characters');
}
