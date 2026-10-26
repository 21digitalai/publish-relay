import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ media: vi.fn(), load: vi.fn(), ready: vi.fn() }));
vi.mock('../src/modules/providers/fanvue-job-media-source.js', () => ({
  getFanvueJobMediaMetadata: mock.media,
}));
vi.mock('../src/modules/providers/fanvue-upload-progress.repository.js', () => ({
  getFanvueProcessingMediaUuid: mock.load,
  markFanvueUploadReady: mock.ready,
}));
vi.mock('../src/modules/content/provider-staging-lock.js', () => ({
  withProviderStagingLock: async (_database: unknown, _id: string, work: () => Promise<unknown>) =>
    work(),
}));

import { refreshFanvueUploadReadiness } from '../src/modules/providers/fanvue-upload-readiness.service.js';

const mediaUuid = '00000000-0000-4000-8000-000000000001';
const input = {
  workspaceId: 'workspace',
  jobId: 'job',
  mediaId: 'media',
  artifactId: 'artifact',
  leaseOwner: 'worker',
  accessToken: 'token',
};
const client = {
  getStatus: vi.fn(() => Promise.resolve({ uuid: mediaUuid, status: 'processing' })),
};

beforeEach(() => {
  vi.clearAllMocks();
  mock.load.mockResolvedValue(mediaUuid);
  mock.media.mockResolvedValue({ byteSize: 5, mimeType: 'image/jpeg' });
  mock.ready.mockResolvedValue(true);
});

describe('Fanvue media readiness', () => {
  it('does not finalize processing media', async () => {
    expect(await refreshFanvueUploadReadiness({} as never, client as never, input)).toBe(false);
    expect(mock.ready).not.toHaveBeenCalled();
  });

  it('finalizes only a matching ready provider UUID', async () => {
    client.getStatus.mockResolvedValueOnce({ uuid: mediaUuid, status: 'ready' });
    expect(await refreshFanvueUploadReadiness({} as never, client as never, input)).toBe(true);
    expect(mock.ready).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mediaUuid }),
    );
  });

  it('refuses missing or mismatched provider identity before finalization', async () => {
    mock.load.mockResolvedValueOnce(null);
    await expect(refreshFanvueUploadReadiness({} as never, client as never, input)).rejects.toThrow(
      'unavailable',
    );
    expect(client.getStatus).not.toHaveBeenCalled();
    client.getStatus.mockResolvedValueOnce({ uuid: 'other', status: 'ready' });
    await expect(refreshFanvueUploadReadiness({} as never, client as never, input)).rejects.toThrow(
      'mismatch',
    );
    expect(mock.ready).not.toHaveBeenCalled();
  });

  it('does not finalize provider processing failure', async () => {
    client.getStatus.mockResolvedValueOnce({ uuid: mediaUuid, status: 'error' });
    await expect(refreshFanvueUploadReadiness({} as never, client as never, input)).rejects.toThrow(
      'processing failed',
    );
    expect(mock.ready).not.toHaveBeenCalled();
  });
});
