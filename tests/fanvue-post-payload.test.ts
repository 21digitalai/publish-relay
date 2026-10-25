import { describe, expect, it } from 'vitest';

import { buildFanvuePostPayload } from '../src/modules/providers/fanvue-post-payload.js';

const mediaId = '00000000-0000-4000-8000-000000000001';
const providerId = '00000000-0000-4000-8000-000000000002';
const ready = new Map([[mediaId, providerId]]);

describe('Fanvue job payload mapping', () => {
  it('preserves explicit free text audience with no media', () => {
    expect(
      buildFanvuePostPayload(
        { schemaVersion: 1, kind: 'post', audience: 'subscribers', text: 'Hello', mediaIds: [] },
        ready,
      ),
    ).toEqual({
      audience: 'subscribers',
      text: 'Hello',
    });
  });

  it('maps paid media and preview to ready provider UUIDs only', () => {
    expect(
      buildFanvuePostPayload(
        {
          schemaVersion: 1,
          kind: 'post',
          audience: 'followers-and-subscribers',
          text: 'Clip',
          mediaIds: [mediaId],
          mediaPreviewId: mediaId,
          price: 300,
        },
        ready,
      ),
    ).toEqual({
      audience: 'followers-and-subscribers',
      text: 'Clip',
      mediaUuids: [providerId],
      mediaPreviewUuid: providerId,
      price: 300,
    });
  });

  it('refuses missing or unverified provider media', () => {
    const content = {
      schemaVersion: 1 as const,
      kind: 'post' as const,
      audience: 'subscribers' as const,
      mediaIds: [mediaId],
    };
    expect(() => buildFanvuePostPayload(content, new Map())).toThrow('not provider-ready');
    expect(() => buildFanvuePostPayload(content, new Map([[mediaId, 'bad']]))).toThrow(
      'not provider-ready',
    );
  });
});
