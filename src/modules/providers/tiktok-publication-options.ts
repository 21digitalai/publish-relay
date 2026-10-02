import { z } from 'zod';

export const TIKTOK_CAPTION_MAX_LENGTH = 2200;

export const tiktokCommercialContentSchema = z.enum(['none', 'own_brand', 'branded', 'both']);
export type TikTokCommercialContent = z.infer<typeof tiktokCommercialContentSchema>;

export function commercialContentFromFlags(
  ownBrand: boolean,
  branded: boolean,
): TikTokCommercialContent {
  if (ownBrand && branded) return 'both';
  if (ownBrand) return 'own_brand';
  if (branded) return 'branded';
  return 'none';
}

export function commercialContentFlags(value: TikTokCommercialContent): {
  brandOrganic: boolean;
  brandContent: boolean;
} {
  return {
    brandOrganic: value === 'own_brand' || value === 'both',
    brandContent: value === 'branded' || value === 'both',
  };
}

export function brandedVisibilityAllowed(privacy: string): boolean {
  return privacy === 'PUBLIC_TO_EVERYONE' || privacy === 'MUTUAL_FOLLOW_FRIENDS';
}
