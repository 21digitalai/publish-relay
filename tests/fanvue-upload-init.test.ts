import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ media: vi.fn(), reserve: vi.fn(), record: vi.fn() }));
vi.mock('../src/modules/providers/fanvue-job-media-source.js', () => ({
  getFanvueJobMediaMetadata: mock.media,
}));
vi.mock('../src/modules/providers/fanvue-upload-init.repository.js', () => ({
  reserveFanvueUploadSession: mock.reserve,
  recordFanvueUploadSession: mock.record,
}));
vi.mock('../src/modules/content/provider-staging-lock.js', () => ({
  withProviderStagingLock: async (_database: unknown, _id: string, work: () => Promise<unknown>) =>
    work(),
}));

import { initializeFanvueUpload } from '../src/modules/providers/fanvue-upload-init.service.js';

const events: string[] = [];
const input = {
  workspaceId: 'workspace',
  jobId: 'job',
  mediaId: 'media',
  artifactId: 'artifact',
  leaseOwner: 'worker',
  accessToken: 'token',
};
const client = {
  createSession: vi.fn(() => {
    events.push('create');
    return Promise.resolve({
      uploadId: 'upload-one',
      mediaUuid: '00000000-0000-4000-8000-000000000001',
      partSize: 5,
      maxParts: 256,
      totalParts: 2,
    });
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  mock.media.mockResolvedValue({ byteSize: 8, mimeType: 'image/jpeg' });
  mock.reserve.mockImplementation(() => {
    events.push('reserve');
    return Promise.resolve(true);
  });
  mock.record.mockImplementation(() => {
    events.push('record');
    return Promise.resolve({ credentialId: 'credential', credentialVersion: 1 });
  });
});

describe('Fanvue upload session initialization', () => {
  it('binds ready job media and reserves before one provider session creation', async () => {
    const result = await initializeFanvueUpload({} as never, client as never, {} as never, input);
    expect(events).toEqual(['reserve', 'create', 'record']);
    expect(client.createSession).toHaveBeenCalledWith('token', {
      name: 'Publish Relay media',
      filename: 'media.jpg',
      mediaType: 'image',
      sizeBytes: 8,
    });
    expect(result.session.partCount).toBe(2);
  });

  it('never calls provider for unsupported media or unavailable reservation', async () => {
    mock.media.mockResolvedValueOnce({ byteSize: 8, mimeType: 'application/pdf' });
    await expect(
      initializeFanvueUpload({} as never, client as never, {} as never, input),
    ).rejects.toThrow('unsupported');
    mock.reserve.mockResolvedValueOnce(false);
    await expect(
      initializeFanvueUpload({} as never, client as never, {} as never, input),
    ).rejects.toThrow('not eligible');
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it('leaves a possibly created session pending after provider transport failure', async () => {
    client.createSession.mockRejectedValueOnce(new Error('timeout'));
    await expect(
      initializeFanvueUpload({} as never, client as never, {} as never, input),
    ).rejects.toThrow('timeout');
    expect(events).toEqual(['reserve']);
    expect(mock.record).not.toHaveBeenCalled();
  });
});
