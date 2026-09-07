import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/tenant-transaction.js', () => ({
  withTenantTransaction: vi.fn(
    (_database: unknown, _tenant: unknown, work: (transaction: unknown) => unknown) => work({}),
  ),
}));
vi.mock('../src/modules/content/provider-staging-lock.js', () => ({
  withProviderStagingLock: vi.fn((_database: unknown, _id: string, work: () => unknown) => work()),
}));
vi.mock('../src/modules/content/provider-staging.repository.js', () => ({
  findStagingArtifact: vi.fn(),
  createStagingArtifact: vi.fn(),
  attachStagingReferenceCredential: vi.fn(),
  getStagingArtifactById: vi.fn(),
  updateStagingByteProgress: vi.fn(),
}));
vi.mock('../src/modules/credentials/credential.repository.js', () => ({
  createCredential: vi.fn(),
  getActiveCredential: vi.fn(),
}));
vi.mock('../src/modules/credentials/envelope.js', () => ({
  encryptCredential: vi.fn(),
  decryptCredential: vi.fn(),
}));

import {
  attachStagingReferenceCredential,
  createStagingArtifact,
  findStagingArtifact,
  getStagingArtifactById,
  updateStagingByteProgress,
} from '../src/modules/content/provider-staging.repository.js';
import {
  createCredential,
  getActiveCredential,
} from '../src/modules/credentials/credential.repository.js';
import { decryptCredential, encryptCredential } from '../src/modules/credentials/envelope.js';
import { stageYouTubeMedia } from '../src/modules/providers/youtube-media-staging.service.js';

const artifact = {
  id: 'artifact-1',
  providerReference: 'youtube:resumable',
  providerReferenceCredentialId: 'credential-1',
  uploadPhase: 'initialized',
  nextSegment: 0,
  nextByteOffset: 0,
  externalObjectId: null,
  expiresAt: new Date('2026-09-09T00:00:00Z'),
};

describe('stageYouTubeMedia', () => {
  beforeEach(() => vi.clearAllMocks());

  it('encrypts a new session and persists provider-authoritative chunk progress', async () => {
    const loadedBuffers: Buffer[] = [];
    let encryptedSession = '';
    vi.mocked(findStagingArtifact).mockResolvedValue(null);
    vi.mocked(createStagingArtifact).mockResolvedValue({ ...artifact, isOwner: true });
    vi.mocked(createCredential).mockResolvedValue({ id: 'credential-1' } as never);
    vi.mocked(getStagingArtifactById).mockResolvedValue(artifact);
    vi.mocked(getActiveCredential).mockResolvedValue({ id: 'credential-1' } as never);
    vi.mocked(encryptCredential).mockImplementation((plaintext) => {
      encryptedSession = plaintext.toString('utf8');
      return Promise.resolve({} as never);
    });
    vi.mocked(decryptCredential).mockResolvedValue(
      Buffer.from('https://www.googleapis.com/upload/youtube/v3/videos?upload_id=one'),
    );
    const client = {
      initiateUpload: vi
        .fn()
        .mockResolvedValue('https://www.googleapis.com/upload/youtube/v3/videos?upload_id=one'),
      queryUpload: vi.fn().mockResolvedValue({ status: 'incomplete', nextOffset: 2 }),
      uploadChunk: vi.fn().mockResolvedValue({ status: 'complete', videoId: 'video-1' }),
    };

    await expect(
      stageYouTubeMedia(
        {} as never,
        {
          load: vi.fn().mockImplementation(() => {
            const bytes = Buffer.from('video');
            loadedBuffers.push(bytes);
            return Promise.resolve({ bytes, mimeType: 'video/mp4' });
          }),
        },
        client as never,
        {} as never,
        {
          workspaceId: 'workspace-1',
          jobId: 'job-1',
          mediaId: 'media-1',
          accessToken: 'access',
          metadata: { snippet: { title: 'Clip' } },
          notifySubscribers: false,
        },
      ),
    ).resolves.toEqual({ videoId: 'video-1' });

    expect(encryptedSession).toBe(
      'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=one',
    );
    expect(attachStagingReferenceCredential).toHaveBeenCalledWith(
      expect.anything(),
      'workspace-1',
      'artifact-1',
      'credential-1',
    );
    expect(client.uploadChunk).toHaveBeenCalledWith(
      expect.objectContaining({ startOffset: 2, totalBytes: 5 }),
    );
    expect(updateStagingByteProgress).toHaveBeenCalledWith(
      expect.anything(),
      'workspace-1',
      'artifact-1',
      { uploadPhase: 'finalized', nextByteOffset: 0, externalObjectId: 'video-1' },
    );
    expect(loadedBuffers).toHaveLength(2);
    expect(loadedBuffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  });

  it('returns a durable video id without decrypting or contacting Google', async () => {
    vi.mocked(findStagingArtifact).mockResolvedValue({ ...artifact, externalObjectId: 'video-2' });
    vi.mocked(getStagingArtifactById).mockResolvedValue({
      ...artifact,
      externalObjectId: 'video-2',
    });
    const client = { queryUpload: vi.fn() };
    const source = { load: vi.fn() };

    await expect(
      stageYouTubeMedia({} as never, source, client as never, {} as never, {
        workspaceId: 'workspace-1',
        jobId: 'job-1',
        mediaId: 'media-1',
        accessToken: 'access',
        metadata: {},
        notifySubscribers: false,
      }),
    ).resolves.toEqual({ videoId: 'video-2' });
    expect(source.load).not.toHaveBeenCalled();
    expect(decryptCredential).not.toHaveBeenCalled();
    expect(client.queryUpload).not.toHaveBeenCalled();
  });
});
