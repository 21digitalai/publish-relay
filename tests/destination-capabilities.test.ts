import { describe, expect, it } from 'vitest';

import {
  capabilityFreshness,
  destinationCapabilities,
  intersectContentKinds,
} from '../src/modules/providers/destination-capabilities.js';

describe('destination capabilities', () => {
  it('exposes the phase-one Instagram and Facebook shapes', () => {
    expect(destinationCapabilities('instagram').contentKinds).toEqual(['single_image', 'carousel']);
    expect(destinationCapabilities('facebook_page').contentKinds).toEqual(['link', 'single_image']);
  });

  it('advertises the same single Fanvue post shape used by Composer admission', () => {
    expect(destinationCapabilities('fanvue')).toEqual({
      schemaVersion: 1,
      contentKinds: ['post'],
      media: { maxImages: 20 },
    });
  });

  it('limits a combined Meta composition to the capability intersection', () => {
    expect(
      intersectContentKinds([
        destinationCapabilities('instagram'),
        destinationCapabilities('facebook_page'),
      ]),
    ).toEqual(['single_image']);
  });

  it('reports fresh, stale, and unknown snapshots deterministically', () => {
    const now = new Date('2026-09-17T12:00:00Z');
    expect(capabilityFreshness(null, now)).toBe('unknown');
    expect(capabilityFreshness(new Date('2026-09-17T11:00:00Z'), now)).toBe('fresh');
    expect(capabilityFreshness(new Date('2026-09-15T11:00:00Z'), now)).toBe('stale');
  });
});
