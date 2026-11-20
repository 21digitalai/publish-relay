import { describe, expect, it } from 'vitest';

import {
  mergeFanvueMedia,
  normalizeFanvueUsdPrice,
  type FanvueVaultMedia,
} from '../src/ui/fanvue-vault-price-model.js';

const media = (id: string, priceUsd: string | null = null): FanvueVaultMedia => ({
  id,
  name: `Media ${id}`,
  folderId: 'folder-1',
  folderName: 'DMs',
  priceUsd,
  previewSrc: `/api/previews/${id}`,
});

describe('Fanvue vault price control model', () => {
  it('treats blank as unset and normalizes supported USD decimals', () => {
    expect(normalizeFanvueUsdPrice('')).toBeNull();
    expect(normalizeFanvueUsdPrice('  ')).toBeNull();
    expect(normalizeFanvueUsdPrice('3')).toBe('3.00');
    expect(normalizeFanvueUsdPrice('3.5')).toBe('3.50');
    expect(normalizeFanvueUsdPrice('3.50')).toBe('3.50');
  });

  it.each(['-1', '1.234', '$3', 'free', '01.00'])('rejects unsupported price draft %s', (draft) => {
    expect(() => normalizeFanvueUsdPrice(draft)).toThrow(
      'Enter a USD amount with no more than two decimal places.',
    );
  });

  it('appends pages without duplicate media identities and accepts refreshed truth', () => {
    expect(mergeFanvueMedia([media('a'), media('b')], [media('b', '4.00'), media('c')])).toEqual([
      media('a'),
      media('b', '4.00'),
      media('c'),
    ]);
  });
});
