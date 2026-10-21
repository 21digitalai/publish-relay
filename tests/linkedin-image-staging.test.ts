import { describe, expect, it, vi } from 'vitest';

import { stageLinkedInImage } from '../src/modules/providers/linkedin-image-staging.service.js';
import { LinkedInRequestError } from '../src/modules/providers/linkedin-http-client.js';

const image = 'urn:li:image:asset';
const scope = {
  credential: {
    accessToken: 'access',
    expiresAt: '2030-01-01T00:00:00.000Z',
    memberUrn: 'urn:li:person:member',
    scope: 'w_member_social',
  },
  workspaceId: 'workspace',
  mediaId: 'media',
};

function fixture(phase: 'reserved' | 'processing' | 'available' | 'failed') {
  return {
    artifact: {
      ensure: vi.fn().mockResolvedValue({ phase, video: phase === 'reserved' ? null : image }),
      recordUploaded: vi.fn().mockResolvedValue(undefined),
      recordStatus: vi.fn().mockResolvedValue(undefined),
    },
    client: {
      uploadImage: vi.fn().mockResolvedValue(image),
      getImageStatus: vi.fn().mockResolvedValue('AVAILABLE' as const),
    },
    source: {
      load: vi.fn().mockResolvedValue({ bytes: Buffer.alloc(100), mimeType: 'image/png' }),
    },
  };
}

describe('LinkedIn image staging', () => {
  it('uploads a reserved job image once and records availability', async () => {
    const services = fixture('reserved');
    await expect(stageLinkedInImage({ ...scope, ...services })).resolves.toEqual({
      state: 'available',
      image,
    });
    expect(services.client.uploadImage).toHaveBeenCalledWith({
      credential: scope.credential,
      bytes: Buffer.alloc(100),
      mimeType: 'image/png',
    });
    expect(services.artifact.recordUploaded).toHaveBeenCalledWith(image);
    expect(services.artifact.recordStatus).toHaveBeenCalledWith(image, 'AVAILABLE');
  });

  it('resumes processing without uploading and holds the post until ready', async () => {
    const services = fixture('processing');
    services.client.getImageStatus.mockResolvedValueOnce('PROCESSING');
    await expect(stageLinkedInImage({ ...scope, ...services })).resolves.toEqual({
      state: 'pending',
      image,
    });
    expect(services.client.uploadImage).not.toHaveBeenCalled();
  });

  it('fails closed on processing failure or status denial', async () => {
    const failed = fixture('processing');
    failed.client.getImageStatus.mockResolvedValueOnce('PROCESSING_FAILED');
    await expect(stageLinkedInImage({ ...scope, ...failed })).rejects.toThrow('processing failed');
    expect(failed.artifact.recordStatus).toHaveBeenCalledWith(image, 'PROCESSING_FAILED');
    const denied = fixture('processing');
    denied.client.getImageStatus.mockRejectedValueOnce(
      new LinkedInRequestError(403, 'auth', 'HTTP 403'),
    );
    await expect(stageLinkedInImage({ ...scope, ...denied })).rejects.toThrow(
      'readiness is unavailable',
    );
    expect(denied.artifact.recordStatus).not.toHaveBeenCalled();
  });
});
