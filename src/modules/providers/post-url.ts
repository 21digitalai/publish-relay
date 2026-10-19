const providerHosts: Record<string, readonly string[]> = {
  x: ['x.com', 'twitter.com'],
  facebook_page: ['facebook.com', 'fb.com'],
  instagram: ['instagram.com'],
  youtube: ['youtube.com', 'youtu.be'],
  linkedin: ['linkedin.com'],
  tiktok: ['tiktok.com'],
};

export function validatedPostUrl(url: string | null | undefined, provider?: string): string | null {
  if (!url || url.length > 2_048) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const allowed = provider ? providerHosts[provider] : Object.values(providerHosts).flat();
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !allowed?.some((domain) => host === domain || host === `www.${domain}`)
    )
      return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function providerPostUrl(input: {
  provider: string;
  id: string;
  storedUrl?: string | null;
  handle?: string | null;
}): string | null {
  const stored = validatedPostUrl(input.storedUrl, input.provider);
  if (stored) return stored;
  const id = encodeURIComponent(input.id);
  if (input.provider === 'facebook_page') return `https://www.facebook.com/${id}`;
  if (input.provider === 'youtube') return `https://www.youtube.com/watch?v=${id}`;
  if (input.provider === 'linkedin') return `https://www.linkedin.com/feed/update/${id}/`;
  if (input.provider === 'tiktok' && input.handle && /^\d+$/.test(input.id))
    return `https://www.tiktok.com/@${encodeURIComponent(input.handle)}/video/${id}`;
  if (input.provider === 'x' && input.handle)
    return `https://x.com/${encodeURIComponent(input.handle)}/status/${id}`;
  return null;
}
