import { describe, expect, it, vi } from 'vitest';

import { FanvueReadService } from '../src/modules/providers/fanvue-read.service.js';

describe('Fanvue media preview selection', () => {
  it('uses a gallery thumbnail when the provider omits the requested thumbnail variant', async () => {
    const readClient = {
      getMediaThumbnail: vi.fn().mockResolvedValue({
        uuid: '00000000-0000-4000-8000-000000000001',
        status: 'ready',
        variants: [
          { variantType: 'main', url: 'https://media.fanvue.com/private/main.jpg' },
          {
            variantType: 'thumbnail_gallery',
            url: 'https://media.fanvue.com/private/gallery.jpg',
          },
        ],
      }),
    };
    const service = new FanvueReadService(
      {} as never,
      {} as never,
      {} as never,
      readClient as never,
    );
    Object.defineProperty(service, 'accessToken', {
      value: vi.fn().mockResolvedValue('token'),
    });

    await expect(
      service.getMediaThumbnail({
        workspaceId: '00000000-0000-4000-8000-000000000002',
        accountId: '00000000-0000-4000-8000-000000000003',
        mediaUuid: '00000000-0000-4000-8000-000000000001',
      }),
    ).resolves.toEqual({
      status: 'ready',
      url: 'https://media.fanvue.com/private/gallery.jpg',
    });
  });
});
