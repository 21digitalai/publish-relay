import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ media: vi.fn(), create: vi.fn(), initialize: vi.fn() }));
vi.mock('../src/modules/providers/fanvue-job-media-source.js', () => ({
  getFanvueJobMediaMetadata: mock.media,
}));
vi.mock('../src/modules/content/provider-staging.repository.js', () => ({
  createStagingArtifact: mock.create,
}));
vi.mock('../src/modules/providers/fanvue-upload-init.service.js', () => ({
  initializeFanvueUpload: mock.initialize,
}));
vi.mock('../src/database/tenant-transaction.js', () => ({
  withTenantTransaction: async (
    _database: unknown,
    _input: unknown,
    work: (tx: unknown) => Promise<unknown>,
  ) => work({}),
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
  mock.create.mockResolvedValue({ id: 'artifact', providerReference: 'fanvue:multipart' });
  mock.initialize.mockResolvedValue({ credentialId: 'credential' });
});

describe('Fanvue job/media staging reservation', () => {
  it('binds a canonical artifact before starting provider session creation', async () => {
    await beginFanvueMediaStaging({} as never, {} as never, {} as never, input);
    expect(mock.create).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: 'workspace',
      jobId: 'job',
      mediaId: 'media',
      providerReference: 'fanvue:multipart',
      expiresAt: new Date('2026-10-26T00:00:00Z'),
    });
    expect(mock.initialize).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ artifactId: 'artifact' }),
    );
  });

  it('refuses to attach to a different provider artifact', async () => {
    mock.create.mockResolvedValueOnce({ id: 'artifact', providerReference: 'youtube:resumable' });
    await expect(
      beginFanvueMediaStaging({} as never, {} as never, {} as never, input),
    ).rejects.toThrow('another provider');
    expect(mock.initialize).not.toHaveBeenCalled();
  });
});
