import type { Readable } from 'node:stream';

import { fanvuePartRange, type FanvueUploadPlan } from './fanvue-media-upload-plan.js';

export async function* streamFanvueUploadParts(
  stream: Readable,
  plan: FanvueUploadPlan,
  startPart: number,
): AsyncGenerator<{ partNumber: number; bytes: Buffer }> {
  const first = fanvuePartRange(plan, startPart);
  let partNumber = startPart;
  let part = Buffer.alloc(first.byteLength);
  let filled = 0;
  let seen = 0;
  const expected = plan.byteSize - first.start;

  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    if (seen + chunk.length > expected)
      throw new Error('Verified media stream exceeded upload plan');
    seen += chunk.length;
    let offset = 0;
    while (offset < chunk.length) {
      const copied = chunk.copy(part, filled, offset);
      filled += copied;
      offset += copied;
      if (filled !== part.length) continue;
      yield { partNumber, bytes: part };
      partNumber += 1;
      if (partNumber <= plan.partCount) {
        part = Buffer.alloc(fanvuePartRange(plan, partNumber).byteLength);
        filled = 0;
      }
    }
  }
  if (seen !== expected || partNumber !== plan.partCount + 1)
    throw new Error('Verified media stream ended before upload plan');
}
