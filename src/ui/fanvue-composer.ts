export type FanvueAudience = 'subscribers' | 'followers-and-subscribers';

export function fanvuePriceCents(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return NaN;
  const [dollars = '0', cents = ''] = trimmed.split('.');
  const amount = Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount >= 300 ? amount : NaN;
}

export function fanvuePostContent(input: {
  audience: FanvueAudience;
  text: string;
  mediaIds: string[];
  price: string;
}) {
  const price = fanvuePriceCents(input.price);
  if (Number.isNaN(price)) throw new Error('Paid Fanvue posts start at $3.00.');
  if (price !== null && input.mediaIds.length === 0)
    throw new Error('Add media before setting a Fanvue price.');
  if (!input.text.trim() && input.mediaIds.length === 0)
    throw new Error('Add text or media to this Fanvue post.');
  return {
    schemaVersion: 1 as const,
    kind: 'post' as const,
    audience: input.audience,
    text: input.text.trim(),
    mediaIds: input.mediaIds,
    ...(price === null ? {} : { price }),
  };
}
