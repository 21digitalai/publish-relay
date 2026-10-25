import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ media: vi.fn(), create: vi.fn(), initialize: vi.fn() }));
vi.mock('../src/modules/providers/fanvue-job-media-source.js', () => ({
  getFanvueJobMediaMetadata: mock.media,
}));
vi.mock('../src/modules/providers/fanvue-artifact.repository.js', () => ({
  reserveFanvueStagingArtifact: mock.create,
}));
vi.mock('../src/modules/providers/fanvue-upload-init.service.js', () => ({
  initializeFanvueUpload: mock.initialize,
}));

import { beginFanvueMediaStaging } from '../src/modules/providers/fanvue-media-staging.service.js';

const input = {
  workspaceId: 'workspace',
  jobId: 'job',
  mediaId: 'media',
  leaseOwner: 'worker',
  accessToken: 'token',
  now: new Date('2026-10-25T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mock.media.mockResolvedValue({ byteSize: 8, mimeType: 'image/jpeg' });
  mock.create.mockResolvedValue('artifact');
  mock.initialize.mockResolvedValue({ credentialId: 'credential' });
});

describe('Fanvue job/media staging reservation', () => {
  it('binds a canonical artifact before starting provider session creation', async () => {
    await beginFanvueMediaStaging({} as never, {} as never, {} as never, input);
    expect(mock.create).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: 'workspace',
      jobId: 'job',
      mediaId: 'media',
      leaseOwner: 'worker',
      expiresAt: new Date('2026-10-26T00:00:00Z'),
    });
    expect(mock.initialize).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ artifactId: 'artifact' }),
    );
  });

  it('refuses an ineligible or duplicate artifact reservation', async () => {
    mock.create.mockResolvedValueOnce(null);
    await expect(
      beginFanvueMediaStaging({} as never, {} as never, {} as never, input),
    ).rejects.toThrow('not eligible');
    expect(mock.initialize).not.toHaveBeenCalled();
  });
});
