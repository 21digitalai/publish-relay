import { describe, expect, it } from 'vitest';

import {
  appendFanvuePartReceipt,
  createFanvueUploadSession,
  parseFanvueUploadSession,
} from '../src/modules/providers/fanvue-upload-session.js';

const provider = {
  uploadId: 'session',
  mediaUuid: '00000000-0000-4000-8000-000000000001',
  partSize: 6,
  maxParts: 256,
  totalParts: 3,
};

describe('Fanvue encrypted upload-session payload', () => {
  it('keeps each ETag in the same ordered state as the durable next offset', () => {
    const initial = createFanvueUploadSession(13, provider);
    const first = appendFanvuePartReceipt(initial, 1, 'etag-one');
    expect(first.nextByteOffset).toBe(6);
    const second = appendFanvuePartReceipt(first.state, 2, 'etag-two');
    expect(second.nextByteOffset).toBe(12);
    const last = appendFanvuePartReceipt(second.state, 3, 'etag-three');
    expect(last.nextByteOffset).toBe(13);
    expect(last.state.parts).toEqual([
      { PartNumber: 1, ETag: 'etag-one' },
      { PartNumber: 2, ETag: 'etag-two' },
      { PartNumber: 3, ETag: 'etag-three' },
    ]);
  });

  it('rejects replay, gaps and corrupted receipt order before completion', () => {
    const initial = createFanvueUploadSession(13, provider);
    expect(() => appendFanvuePartReceipt(initial, 2, 'etag')).toThrow('not next');
    const first = appendFanvuePartReceipt(initial, 1, 'etag');
    expect(() => appendFanvuePartReceipt(first.state, 1, 'again')).toThrow('not next');
    expect(() =>
      parseFanvueUploadSession({ ...first.state, parts: [{ PartNumber: 2, ETag: 'etag' }] }),
    ).toThrow('inconsistent');
  });

  it('rejects more receipts than the planned part count and oversized ETags', () => {
    const initial = createFanvueUploadSession(6, { ...provider, totalParts: 1 });
    const completed = appendFanvuePartReceipt(initial, 1, 'etag');
    expect(() => appendFanvuePartReceipt(completed.state, 2, 'extra')).toThrow('not next');
    expect(() =>
      parseFanvueUploadSession({
        ...completed.state,
        parts: [...completed.state.parts, { PartNumber: 2, ETag: 'extra' }],
      }),
    ).toThrow('inconsistent');
    expect(() => appendFanvuePartReceipt(initial, 1, 'x'.repeat(1025))).toThrow('not next');
    expect(() =>
      parseFanvueUploadSession({
        ...initial,
        parts: [{ PartNumber: 1, ETag: 'x'.repeat(1025) }],
      }),
    ).toThrow();
  });
});
