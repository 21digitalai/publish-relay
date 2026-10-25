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
});
