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
  | { kind: 'link'; text: string; linkUrl: string; title: string; description?: string };

export function parseLinkedInContent(
  content: unknown,
  mediaIds: readonly string[],
): LinkedInContent {
  if (mediaIds.length !== 0) throw new Error('LinkedIn article and text posts do not accept media');
  const article = linkedInArticleSchema.safeParse(content);
  if (article.success)
    return {
      kind: 'link',
      text: article.data.text,
      linkUrl: article.data.linkUrl,
      title: article.data.title,
      ...(article.data.description === undefined ? {} : { description: article.data.description }),
    };
  const text = linkedInTextSchema.safeParse(content);
  if (text.success) return { kind: 'text', text: text.data.text };
  throw new Error('LinkedIn requires text up to 3000 characters or an HTTPS article with a title');
}

export function validateLinkedInTextContent(content: unknown, mediaIds: readonly string[]): void {
  if (mediaIds.length !== 0 || !linkedInTextSchema.safeParse(content).success)
    throw new Error('LinkedIn member posts require text only, up to 3000 characters');
}
