import { describe, expect, it, vi } from 'vitest';

import type {
  XMediaSource,
  XMediaUploadClient,
} from '../src/modules/providers/x-media-staging.service.js';
import { stageXJobMedia } from '../src/modules/providers/x-media-dispatch.service.js';

vi.mock('../src/modules/providers/x-media-staging.service.js', () => ({ stageXMedia: vi.fn() }));

import { stageXMedia } from '../src/modules/providers/x-media-staging.service.js';

describe('X media dispatch composition', () => {
  it('binds one credential-scoped client and stages every scheduled job media item', async () => {
    const client = {} as XMediaUploadClient;
    const createClient = vi.fn(() => client);
    vi.mocked(stageXMedia)
      .mockResolvedValueOnce({ mediaId: 'x-media-1', state: 'succeeded' })
      .mockResolvedValueOnce({ mediaId: 'x-media-2', state: 'pending' });

    const result = await stageXJobMedia({} as never, {} as XMediaSource, createClient, {
      workspaceId: 'workspace-1',
      jobId: 'job-1',
      credential: '{"accessToken":"sanitized","accessTokenSecret":"sanitized"}',
      mediaIds: ['media-1', 'media-2'],
      idempotencyKey: 'job-key',
    });

    expect(createClient).toHaveBeenCalledOnce();
    expect(stageXMedia).toHaveBeenNthCalledWith(1, expect.anything(), expect.anything(), client, {
      workspaceId: 'workspace-1',
      jobId: 'job-1',
      mediaId: 'media-1',
      idempotencyKey: 'job-key:media-1',
    });
    expect(stageXMedia).toHaveBeenNthCalledWith(2, expect.anything(), expect.anything(), client, {
      workspaceId: 'workspace-1',
      jobId: 'job-1',
      mediaId: 'media-2',
      idempotencyKey: 'job-key:media-2',
    });
    expect(result).toEqual({ mediaIds: ['x-media-1', 'x-media-2'], state: 'pending' });
  });
});
