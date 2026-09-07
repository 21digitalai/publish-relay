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
import { withProviderStagingLock } from '../src/modules/content/provider-staging-lock.js';
import { withTenantTransaction } from '../src/database/tenant-transaction.js';
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
    vi.mocked(getStagingArtifactById)
      .mockResolvedValueOnce({ ...artifact, providerReferenceCredentialId: null })
      .mockResolvedValue(artifact);
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
      uploadChunk: vi.fn()
        .mockResolvedValueOnce({ status: 'incomplete', nextOffset: 4 })
        .mockResolvedValueOnce({ status: 'complete', videoId: 'video-1' }),
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
      { uploadPhase: 'uploading', nextByteOffset: 4 },
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

  it('zeroes loaded media when initialization validation or credential loading fails', async () => {
    const invalid = Buffer.from('invalid');
    vi.mocked(findStagingArtifact).mockResolvedValueOnce(null);
    vi.mocked(createStagingArtifact).mockResolvedValueOnce({ ...artifact, isOwner: true, providerReferenceCredentialId: null });
    vi.mocked(getStagingArtifactById).mockResolvedValueOnce({ ...artifact, providerReferenceCredentialId: null });
    const initiateUpload = vi.fn();
    await expect(stageYouTubeMedia({} as never, { load: vi.fn().mockResolvedValue({ bytes: invalid, mimeType: 'text/plain' }) }, { initiateUpload } as never, {} as never, {
      workspaceId: 'workspace-1', jobId: 'job-1', mediaId: 'media-1', accessToken: 'access', metadata: {}, notifySubscribers: false,
    })).rejects.toThrow('requires video/mp4');
    expect(invalid.every((byte) => byte === 0)).toBe(true);
    expect(initiateUpload).not.toHaveBeenCalled();

    const missing = Buffer.from('video');
    vi.mocked(findStagingArtifact).mockResolvedValueOnce(artifact);
    vi.mocked(getStagingArtifactById).mockResolvedValue(artifact);
    vi.mocked(getActiveCredential).mockResolvedValueOnce(null);
    await expect(stageYouTubeMedia({} as never, { load: vi.fn().mockResolvedValue({ bytes: missing, mimeType: 'video/mp4' }) }, {} as never, {} as never, {
      workspaceId: 'workspace-1', jobId: 'job-1', mediaId: 'media-1', accessToken: 'access', metadata: {}, notifySubscribers: false,
    })).rejects.toThrow('session credential is unavailable');
    expect(missing.every((byte) => byte === 0)).toBe(true);
  });

  it('rejects a provider offset that does not advance', async () => {
    vi.mocked(findStagingArtifact).mockResolvedValue(artifact);
    vi.mocked(getStagingArtifactById).mockResolvedValue(artifact);
    vi.mocked(getActiveCredential).mockResolvedValue({ id: 'credential-1' } as never);
    vi.mocked(decryptCredential).mockResolvedValue(Buffer.from('https://www.googleapis.com/upload/youtube/v3/videos?upload_id=one'));
    const client = {
      queryUpload: vi.fn().mockResolvedValue({ status: 'incomplete', nextOffset: 2 }),
      uploadChunk: vi.fn().mockResolvedValue({ status: 'incomplete', nextOffset: 2 }),
    };
    await expect(stageYouTubeMedia({} as never, { load: vi.fn().mockResolvedValue({ bytes: Buffer.from('video'), mimeType: 'video/mp4' }) }, client as never, {} as never, {
      workspaceId: 'workspace-1', jobId: 'job-1', mediaId: 'media-1', accessToken: 'access', metadata: {}, notifySubscribers: false,
    })).rejects.toThrow('offset did not advance');
    expect(updateStagingByteProgress).not.toHaveBeenCalled();
  });

  it('serializes concurrent initialization and reloads durable state under the lock', async () => {
    let durableArtifact = {
      ...artifact,
      providerReferenceCredentialId: null as string | null,
      externalObjectId: null as string | null,
    };
    let lockTail = Promise.resolve();
    vi.mocked(findStagingArtifact).mockResolvedValue(null);
    vi.mocked(createStagingArtifact).mockImplementation(() =>
      Promise.resolve({ ...durableArtifact, isOwner: true } as never),
    );
    vi.mocked(getStagingArtifactById).mockImplementation(() =>
      Promise.resolve({ ...durableArtifact } as never),
    );
    vi.mocked(createCredential).mockResolvedValue({ id: 'credential-1' } as never);
    vi.mocked(attachStagingReferenceCredential).mockImplementation(() => {
      durableArtifact = { ...durableArtifact, providerReferenceCredentialId: 'credential-1' };
      return Promise.resolve(undefined as never);
    });
    vi.mocked(getActiveCredential).mockResolvedValue({ id: 'credential-1' } as never);
    vi.mocked(encryptCredential).mockResolvedValue({} as never);
    vi.mocked(decryptCredential).mockResolvedValue(
      Buffer.from('https://www.googleapis.com/upload/youtube/v3/videos?upload_id=one'),
    );
    vi.mocked(updateStagingByteProgress).mockImplementation((_tx, _workspace, _id, update) => {
      if (update.uploadPhase === 'finalized') {
        durableArtifact = { ...durableArtifact, externalObjectId: update.externalObjectId ?? null };
      }
      return Promise.resolve(undefined as never);
    });
    vi.mocked(withProviderStagingLock).mockImplementation(async (_database, _id, work) => {
      const previous = lockTail;
      let release: () => void = vi.fn();
      lockTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    });
    const client = {
      initiateUpload: vi
        .fn()
        .mockResolvedValue('https://www.googleapis.com/upload/youtube/v3/videos?upload_id=one'),
      queryUpload: vi.fn().mockResolvedValue({ status: 'complete', videoId: 'video-1' }),
    };
    const source = {
      load: vi.fn().mockImplementation(() =>
        Promise.resolve({ bytes: Buffer.from('video'), mimeType: 'video/mp4' }),
      ),
    };
    const input = {
      workspaceId: 'workspace-1', jobId: 'job-1', mediaId: 'media-1', accessToken: 'access',
      metadata: {}, notifySubscribers: false,
    };

    await expect(
      Promise.all([
        stageYouTubeMedia({} as never, source, client as never, {} as never, input),
        stageYouTubeMedia({} as never, source, client as never, {} as never, input),
      ]),
    ).resolves.toEqual([{ videoId: 'video-1' }, { videoId: 'video-1' }]);

    expect(client.initiateUpload).toHaveBeenCalledTimes(1);
    expect(client.queryUpload).toHaveBeenCalledTimes(2);
    expect(getStagingArtifactById).toHaveBeenCalledTimes(4);
  });

  it('rolls back credential creation when attachment fails and repairs the durable intent on retry', async () => {
    const transactionState = { credentialIds: [] as string[] };
    let durableArtifact = {
      ...artifact,
      providerReferenceCredentialId: null as string | null,
      externalObjectId: null as string | null,
    };
    let shouldFailAttach = true;
    vi.mocked(withTenantTransaction).mockImplementation(async (_database, _tenant, work) => {
      const snapshot = [...transactionState.credentialIds];
      try {
        return await work(transactionState as never);
      } catch (error) {
        transactionState.credentialIds = snapshot;
        throw error;
      }
    });
    vi.mocked(findStagingArtifact).mockImplementation(() =>
      Promise.resolve({ ...durableArtifact } as never),
    );
    vi.mocked(getStagingArtifactById).mockImplementation(() =>
      Promise.resolve({ ...durableArtifact } as never),
    );
    vi.mocked(createCredential).mockImplementation((transaction) => {
      expect(transaction).toBe(transactionState);
      transactionState.credentialIds.push('credential-1');
      return Promise.resolve({ id: 'credential-1' } as never);
    });
    vi.mocked(attachStagingReferenceCredential).mockImplementation((transaction) => {
      expect(transaction).toBe(transactionState);
      if (shouldFailAttach) throw new Error('attach failed');
      durableArtifact = { ...durableArtifact, providerReferenceCredentialId: 'credential-1' };
      return Promise.resolve(undefined as never);
    });
    vi.mocked(encryptCredential).mockResolvedValue({} as never);
    vi.mocked(getActiveCredential).mockResolvedValue({ id: 'credential-1' } as never);
    vi.mocked(decryptCredential).mockResolvedValue(
      Buffer.from('https://www.googleapis.com/upload/youtube/v3/videos?upload_id=replacement'),
    );
    const client = {
      initiateUpload: vi
        .fn()
        .mockResolvedValueOnce('https://www.googleapis.com/upload/youtube/v3/videos?upload_id=lost')
        .mockResolvedValueOnce('https://www.googleapis.com/upload/youtube/v3/videos?upload_id=replacement'),
      queryUpload: vi.fn().mockResolvedValue({ status: 'complete', videoId: 'video-1' }),
    };
    const source = { load: vi.fn().mockImplementation(() =>
      Promise.resolve({ bytes: Buffer.from('video'), mimeType: 'video/mp4' })) };
    const input = {
      workspaceId: 'workspace-1', jobId: 'job-1', mediaId: 'media-1', accessToken: 'access',
      metadata: {}, notifySubscribers: false,
    };

    await expect(
      stageYouTubeMedia({} as never, source, client as never, {} as never, input),
    ).rejects.toThrow('attach failed');
    expect(transactionState.credentialIds).toEqual([]);
    expect(durableArtifact.providerReferenceCredentialId).toBeNull();

    shouldFailAttach = false;
    await expect(
      stageYouTubeMedia({} as never, source, client as never, {} as never, input),
    ).resolves.toEqual({ videoId: 'video-1' });
    expect(client.initiateUpload).toHaveBeenCalledTimes(2);
    expect(transactionState.credentialIds).toEqual(['credential-1']);
  });

  it('zeroes media and decrypted session bytes when decryption rejects', async () => {
    const mediaBytes = Buffer.from('video');
    const partialSession = Buffer.from('sensitive-session');
    vi.mocked(findStagingArtifact).mockResolvedValue(artifact);
    vi.mocked(getStagingArtifactById).mockResolvedValue(artifact);
    vi.mocked(getActiveCredential).mockResolvedValue({ id: 'credential-1' } as never);
    vi.mocked(decryptCredential).mockImplementation(() => {
      partialSession.fill(0);
      return Promise.reject(new Error('decrypt failed'));
    });

    await expect(stageYouTubeMedia(
      {} as never,
      { load: vi.fn().mockResolvedValue({ bytes: mediaBytes, mimeType: 'video/mp4' }) },
      {} as never,
      {} as never,
      {
        workspaceId: 'workspace-1', jobId: 'job-1', mediaId: 'media-1', accessToken: 'access',
        metadata: {}, notifySubscribers: false,
      },
    )).rejects.toThrow('decrypt failed');

    expect(mediaBytes.every((byte) => byte === 0)).toBe(true);
    expect(partialSession.every((byte) => byte === 0)).toBe(true);
  });
});
