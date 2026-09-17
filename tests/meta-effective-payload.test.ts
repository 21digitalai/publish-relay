import { describe, expect, it } from 'vitest';

import { buildMetaEffectivePayload } from '../src/modules/content/post.repository.js';

const image = '00000000-0000-4000-8000-000000000501';

describe('Meta effective payloads', () => {
  it('creates independent Instagram and Facebook payload snapshots', () => {
    const content = { kind: 'single_image', text: 'Shared caption' };
    const instagram = buildMetaEffectivePayload(
      'instagram',
      'active',
      content,
      [image],
      ['image/jpeg'],
    );
    const facebook = buildMetaEffectivePayload(
      'facebook_page',
      'active',
      content,
      [image],
      ['image/jpeg'],
    );
    expect(instagram).toEqual({
      schemaVersion: 1,
      destinationProvider: 'instagram',
      kind: 'single_image',
      caption: 'Shared caption',
      mediaIds: [image],
    });
    expect(facebook).toEqual({
      schemaVersion: 1,
      destinationProvider: 'facebook_page',
      kind: 'single_image',
      message: 'Shared caption',
      mediaIds: [image],
    });
    expect(instagram).not.toBe(facebook);
  });

  it('rejects unsupported intersections and unavailable destinations', () => {
    expect(() =>
      buildMetaEffectivePayload(
        'facebook_page',
        'active',
        { kind: 'carousel', text: 'No' },
        [image, `${image}-2`],
        ['image/jpeg', 'image/jpeg'],
      ),
    ).toThrow('Facebook supports link or single image content');
    expect(() =>
      buildMetaEffectivePayload(
        'instagram',
        'permission_lost',
        { kind: 'single_image', text: 'No' },
        [image],
        ['image/jpeg'],
      ),
    ).toThrow('Destination is unavailable: permission_lost');
  });
});
