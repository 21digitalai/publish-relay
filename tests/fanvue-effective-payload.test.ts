import { describe, expect, it } from 'vitest';

import { buildFanvueEffectivePayload } from '../src/modules/content/post.repository.js';

const mediaId = '00000000-0000-4000-8000-000000000001';
const content = {
  schemaVersion: 1,
  kind: 'post',
  audience: 'subscribers',
  text: 'Hello',
  mediaIds: [mediaId],
};

describe('Fanvue job payload admission', () => {
  it('stores explicit free and native paid settings on the target-owned job', () => {
    expect(buildFanvueEffectivePayload(content, [mediaId], ['image/jpeg'])).toEqual(content);
    expect(
      buildFanvueEffectivePayload(
        { ...content, price: 300, mediaPreviewId: mediaId },
        [mediaId],
        ['video/mp4'],
      ),
    ).toMatchObject({ price: 300, mediaPreviewId: mediaId });
  });

  it('denies mismatched, unsupported or below-minimum media settings', () => {
    expect(() => buildFanvueEffectivePayload(content, [], [])).toThrow('does not match');
    expect(() => buildFanvueEffectivePayload(content, [mediaId], ['application/pdf'])).toThrow(
      'unsupported',
    );
    expect(() =>
      buildFanvueEffectivePayload({ ...content, price: 299 }, [mediaId], ['image/jpeg']),
    ).toThrow('Invalid Fanvue');
    expect(() =>
      buildFanvueEffectivePayload(
        { ...content, mediaPreviewId: '00000000-0000-4000-8000-000000000002' },
        [mediaId],
        ['image/jpeg'],
      ),
    ).toThrow('Invalid Fanvue');
  });
});
