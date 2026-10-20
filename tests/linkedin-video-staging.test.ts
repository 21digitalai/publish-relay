import { describe, expect, it, vi } from 'vitest';

import { stageLinkedInVideo } from '../src/modules/providers/linkedin-video-staging.service.js';

const credential = {
  accessToken: 'access',
  expiresAt: '2030-01-01T00:00:00.000Z',
  memberUrn: 'urn:li:person:member',
  scope: 'w_member_social',
};
const scope = { credential, workspaceId: 'workspace', mediaId: 'media' };
const video = 'urn:li:video:asset';

function fixture(phase: 'reserved' | 'processing' | 'available' | 'failed') {
  const artifact = {
    ensure: vi.fn().mockResolvedValue({ phase, video: phase === 'reserved' ? null : video }),
    recordUploaded: vi.fn().mockResolvedValue(undefined),
    recordStatus: vi.fn().mockResolvedValue(undefined),
  };
  const client = {
    uploadVideo: vi.fn().mockResolvedValue(video),
    getVideoStatus: vi.fn().mockResolvedValue('AVAILABLE' as const),
  };
  const source = {
    load: vi.fn().mockResolvedValue({ bytes: Buffer.alloc(75_000), mimeType: 'video/mp4' }),
  };
  return { artifact, client, source };
}

describe('LinkedIn video staging', () => {
  it('uploads a reserved job asset once and records availability', async () => {
    const services = fixture('reserved');
    await expect(stageLinkedInVideo({ ...scope, ...services })).resolves.toEqual({
      state: 'available',
      video,
    });
    expect(services.source.load).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      mediaId: 'media',
    });
    expect(services.artifact.recordUploaded).toHaveBeenCalledWith(video);
    expect(services.artifact.recordStatus).toHaveBeenCalledWith(video, 'AVAILABLE');
  });

  it('resumes processing without reuploading and holds a pending asset', async () => {
    const services = fixture('processing');
    services.client.getVideoStatus.mockResolvedValueOnce('PROCESSING');
    await expect(stageLinkedInVideo({ ...scope, ...services })).resolves.toEqual({
      state: 'pending',
      video,
    });
    expect(services.client.uploadVideo).not.toHaveBeenCalled();
    expect(services.artifact.recordStatus).not.toHaveBeenCalled();
  });

  it('persists processing failure and never reloads an already uploaded asset', async () => {
    const services = fixture('processing');
    services.client.getVideoStatus.mockResolvedValueOnce('PROCESSING_FAILED');
    await expect(stageLinkedInVideo({ ...scope, ...services })).rejects.toThrow(
      'processing failed',
    );
    expect(services.artifact.recordStatus).toHaveBeenCalledWith(video, 'PROCESSING_FAILED');
    expect(services.source.load).not.toHaveBeenCalled();
  });

  it('refuses a failed artifact without any provider call', async () => {
    const services = fixture('failed');
    await expect(stageLinkedInVideo({ ...scope, ...services })).rejects.toThrow(
      'processing failed',
    );
    expect(services.client.getVideoStatus).not.toHaveBeenCalled();
  });
});
