import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  open: vi.fn(),
  reserve: vi.fn(),
  advance: vi.fn(),
}));

vi.mock('../src/modules/providers/fanvue-job-media-source.js', () => ({
  openFanvueJobMediaRange: mock.open,
}));
vi.mock('../src/modules/providers/fanvue-upload-progress.repository.js', () => ({
  reserveFanvueUploadPart: mock.reserve,
  advanceFanvueUploadProgress: mock.advance,
}));
vi.mock('../src/modules/content/provider-staging-lock.js', () => ({
  withProviderStagingLock: async (_database: unknown, _id: string, work: () => Promise<void>) =>
    work(),
}));

import { uploadFanvuePart } from '../src/modules/providers/fanvue-upload-part.service.js';

const session = {
  uploadId: 'upload-one',
  mediaUuid: '00000000-0000-4000-8000-000000000001',
  byteSize: 8,
  partSize: 5,
  partCount: 2,
  parts: [{ PartNumber: 1, ETag: 'first' }],
};
const input = {
  workspaceId: 'workspace',
  jobId: 'job',
  mediaId: 'media',
  artifactId: 'artifact',
  leaseOwner: 'worker',
  credentialId: 'credential',
  credentialVersion: 2,
  session,
  partNumber: 2,
  accessToken: 'token',
};
const events: string[] = [];
const client = {
  signParts: vi.fn(() => {
    events.push('sign');
    return Promise.resolve({ parts: [{ partNumber: 2, url: 'https://upload.example/part' }] });
  }),
  putPart: vi.fn((_url: string, bytes: Buffer) => {
    events.push('put');
    expect(bytes.toString()).toBe('fgh');
    return Promise.resolve('second');
  }),
};

async function run() {
  return uploadFanvuePart({} as never, {} as never, client as never, {} as never, input);
}

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  mock.open.mockResolvedValue({ stream: Readable.from([Buffer.from('fgh')]), byteSize: 8 });
  mock.reserve.mockImplementation(() => {
    events.push('reserve');
    return Promise.resolve(true);
  });
  mock.advance.mockImplementation(() => {
    events.push('advance');
    return Promise.resolve(true);
  });
});

describe('Fanvue one-part staging', () => {
  it('reads only the exact inclusive part range, reserves before PUT and settles the receipt', async () => {
    await run();
    expect(mock.open).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      workspaceId: 'workspace',
      jobId: 'job',
      mediaId: 'media',
      leaseOwner: 'worker',
      start: 5,
      end: 7,
    });
    expect(events).toEqual(['sign', 'reserve', 'put', 'advance']);
    expect(mock.advance).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ etag: 'second' }),
    );
  });

  it('never sends when the durable reservation is unavailable', async () => {
    mock.reserve.mockResolvedValue(false);
    await expect(run()).rejects.toThrow('not eligible');
    expect(client.putPart).not.toHaveBeenCalled();
  });

  it('keeps a possibly sent PUT pending when the provider response fails', async () => {
    client.putPart.mockRejectedValueOnce(new Error('timeout'));
    await expect(run()).rejects.toThrow('timeout');
    expect(events).toEqual(['sign', 'reserve']);
    expect(mock.advance).not.toHaveBeenCalled();
  });

  it('never reserves or sends an incomplete or oversized source range', async () => {
    for (const value of ['fg', 'fghi']) {
      mock.open.mockResolvedValueOnce({ stream: Readable.from([value]), byteSize: 8 });
      await expect(run()).rejects.toThrow('Fanvue media range');
    }
    expect(mock.reserve).not.toHaveBeenCalled();
    expect(client.putPart).not.toHaveBeenCalled();
  });
});
