import { describe, expect, it } from 'vitest';

import {
  fanvuePartRange,
  planFanvueMediaUpload,
} from '../src/modules/providers/fanvue-media-upload-plan.js';

describe('Fanvue media upload plan', () => {
  it('uses bounded one-based parts with an exact shorter final range', () => {
    const plan = planFanvueMediaUpload(13, { partSize: 6, maxParts: 256, totalParts: 3 });
    expect(plan.partCount).toBe(3);
    expect(fanvuePartRange(plan, 1)).toEqual({ start: 0, end: 5, byteLength: 6 });
    expect(fanvuePartRange(plan, 3)).toEqual({ start: 12, end: 12, byteLength: 1 });
    expect(() => fanvuePartRange(plan, 4)).toThrow('out of range');
  });

  it('rejects provider sessions whose declared parts cannot cover the media', () => {
    expect(() =>
      planFanvueMediaUpload(13, { partSize: 6, maxParts: 2, totalParts: null }),
    ).toThrow();
    expect(() =>
      planFanvueMediaUpload(13, { partSize: 6, maxParts: 256, totalParts: 2 }),
    ).toThrow();
    expect(() =>
      planFanvueMediaUpload(257, { partSize: 1, maxParts: 300, totalParts: null }),
    ).toThrow();
    expect(() =>
      planFanvueMediaUpload(17 * 1024 * 1024, {
        partSize: 17 * 1024 * 1024,
        maxParts: 256,
        totalParts: 1,
      }),
    ).toThrow('part size');
    expect(() =>
      planFanvueMediaUpload(0, { partSize: 6, maxParts: 256, totalParts: null }),
    ).toThrow();
  });
});
