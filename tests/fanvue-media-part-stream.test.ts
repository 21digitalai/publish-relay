import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { streamFanvueUploadParts } from '../src/modules/providers/fanvue-media-part-stream.js';
import { planFanvueMediaUpload } from '../src/modules/providers/fanvue-media-upload-plan.js';

const plan = planFanvueMediaUpload(13, { partSize: 6, maxParts: 256, totalParts: 3 });

async function collect(stream: Readable, startPart: number) {
  const parts = [];
  for await (const item of streamFanvueUploadParts(stream, plan, startPart))
    parts.push({ number: item.partNumber, text: item.bytes.toString('utf8') });
  return parts;
}

describe('Fanvue bounded part stream', () => {
  it('chunks one verified source stream at exact provider boundaries', async () => {
    await expect(collect(Readable.from(['abc', 'defghij', 'klm']), 1)).resolves.toEqual([
      { number: 1, text: 'abcdef' },
      { number: 2, text: 'ghijkl' },
      { number: 3, text: 'm' },
    ]);
  });

  it('resumes at the durable next part without reading previous bytes again', async () => {
    await expect(collect(Readable.from(['ghijk', 'lm']), 2)).resolves.toEqual([
      { number: 2, text: 'ghijkl' },
      { number: 3, text: 'm' },
    ]);
  });

  it('fails on truncated or overlong verified stream', async () => {
    await expect(collect(Readable.from(['abcdef']), 1)).rejects.toThrow('ended before');
    await expect(collect(Readable.from(['abcdefghijklmn']), 1)).rejects.toThrow('exceeded');
  });
});
