const FACEBOOK_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png']);

export type NormalizedFacebookPhaseOneContent =
  { kind: 'link'; message: string; linkUrl: string } | { kind: 'single_image'; message: string };

export interface FacebookPhaseOneContentInput {
  kind: unknown;
  message: unknown;
  linkUrl?: unknown;
  mediaMimeTypes: readonly string[];
}

function normalizedMessage(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function canonicalHttpsUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Facebook link posts require a valid HTTPS link');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('invalid protocol');
    return url.toString();
  } catch {
    throw new Error('Facebook link posts require a valid HTTPS link');
  }
}

export function normalizeFacebookPhaseOneContent(
  input: FacebookPhaseOneContentInput,
): NormalizedFacebookPhaseOneContent {
  const message = normalizedMessage(input.message);
  if (input.kind === 'link') {
    if (input.mediaMimeTypes.length !== 0)
      throw new Error('Facebook link posts cannot include uploaded images');
    return { kind: 'link', message, linkUrl: canonicalHttpsUrl(input.linkUrl) };
  }
  if (input.kind !== 'single_image')
    throw new Error('Facebook supports link or single image content');
  if (input.mediaMimeTypes.length !== 1)
    throw new Error('Facebook single image requires exactly one image');
  if (!FACEBOOK_IMAGE_MIME_TYPES.has(input.mediaMimeTypes[0] ?? ''))
    throw new Error('Facebook phase one supports one JPEG/PNG image');
  if (!message) throw new Error('Facebook single image requires a non-empty message');
  return { kind: 'single_image', message };
}
