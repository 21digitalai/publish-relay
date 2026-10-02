import twitterText from 'twitter-text';

export const X_STANDARD_POST_LIMIT = 280;
export const X_DECLARED_LONG_POST_LIMIT = 25_000;

export function weightedXPostLength(text: string): number {
  return twitterText.parseTweet(text).weightedLength;
}

export function composeXThreadText(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
}

function xPostTexts(content: Record<string, unknown>, mediaIds: readonly string[]): string[] {
  const kind = content.kind ?? content.type;
  if (kind !== 'thread') return typeof content.text === 'string' ? [content.text] : [];
  if (!Array.isArray(content.posts) || content.posts.length < 2)
    throw new Error('X thread requires at least two parts');
  const hasObjectPart = content.posts.some((part: unknown) => typeof part !== 'string');
  if (hasObjectPart && content.posts.some((part: unknown) => typeof part === 'string'))
    throw new Error('X thread parts must use one consistent shape');
  const parts = content.posts.map((part: unknown) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string')
      return part.text;
    throw new Error('X thread contains an invalid part');
  });
  return hasObjectPart && mediaIds.length > 0 ? parts : [composeXThreadText(parts)];
}

export function validateXPostLength(
  content: Record<string, unknown>,
  declaredLongPosts: boolean,
  mediaIds: readonly string[] = [],
): void {
  const limit = declaredLongPosts ? X_DECLARED_LONG_POST_LIMIT : X_STANDARD_POST_LIMIT;
  for (const text of xPostTexts(content, mediaIds)) {
    const length = weightedXPostLength(text);
    if (length > limit)
      throw new Error(
        `X post text is ${String(length)} weighted characters; selected account limit is ${String(limit)}`,
      );
  }
}
