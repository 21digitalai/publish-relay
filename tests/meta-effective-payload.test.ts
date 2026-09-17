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
    for (const availability of ['reauth_required', 'permission_lost', 'remote_missing'])
      expect(() =>
        buildMetaEffectivePayload(
          'instagram',
          availability,
          { kind: 'single_image', text: 'No' },
          [image],
          ['image/jpeg'],
        ),
      ).toThrow(`Destination is unavailable: ${availability}`);
  });

  it.each(['image/gif', 'image/webp'])(
    'rejects unsupported Facebook image MIME type %s',
    (mimeType) => {
      expect(() =>
        buildMetaEffectivePayload(
          'facebook_page',
          'active',
          { kind: 'single_image', text: 'Photo' },
          [image],
          [mimeType],
        ),
      ).toThrow('Facebook phase one supports one JPEG/PNG image');
    },
  );

  it.each(['', '   '])('rejects a Facebook image with message %j', (text) => {
    expect(() =>
      buildMetaEffectivePayload(
        'facebook_page',
        'active',
        { kind: 'single_image', text },
        [image],
        ['image/png'],
      ),
    ).toThrow('Facebook single image requires a non-empty message');
  });

  it('persists the canonical Facebook link URL', () => {
    expect(
      buildMetaEffectivePayload(
        'facebook_page',
        'active',
        { kind: 'link', text: 'Read', linkUrl: 'https://EXAMPLE.com/a/../b' },
        [],
        [],
      ),
    ).toEqual({
      schemaVersion: 1,
      destinationProvider: 'facebook_page',
      kind: 'link',
      message: 'Read',
      linkUrl: 'https://example.com/b',
    });
  });
});
