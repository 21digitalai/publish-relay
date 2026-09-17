import { describe, expect, it } from 'vitest';

import { YouTubeProviderAdapter } from '../src/modules/providers/youtube-adapter.js';

function videoContent() {
  return {
    kind: 'video' as const,
    text: '',
    media: [{ id: 'media-1', mimeType: 'video/mp4' }] as [{ id: string; mimeType: string }],
    providerOptions: {
      youtube: {
        schemaVersion: 1 as const,
        title: 'Scheduled release',
        privacyStatus: 'public' as const,
        madeForKids: false,
        notifySubscribers: false,
      },
    },
  };
}

describe('YouTube provider adapter contract', () => {
  it('publishes only one MP4 with explicit audience and visibility metadata', async () => {
    const adapter = new YouTubeProviderAdapter();
    await expect(adapter.validate('channel-1', videoContent())).resolves.toBeUndefined();
    await expect(
      adapter.validate('channel-1', { ...videoContent(), media: [] as never }),
    ).rejects.toThrow('exactly one MP4');
  });

  it('rejects blank or oversized metadata without inventing optional defaults', async () => {
    const adapter = new YouTubeProviderAdapter();
    const blankTitle = videoContent();
    blankTitle.providerOptions.youtube.title = '   ';
    await expect(adapter.validate('channel-1', blankTitle)).rejects.toThrow('title');

    const staged = await adapter.stage('channel-1', videoContent(), 'job-1:revision-1:channel-1');
    expect(staged.content).toEqual(videoContent());
    expect(staged.content).not.toHaveProperty('providerOptions.youtube.tags');
    expect(staged.content).not.toHaveProperty('providerOptions.youtube.categoryId');
  });

  it('fails closed while OAuth, upload, lookup, and revoke transports are absent', async () => {
    const adapter = new YouTubeProviderAdapter();
    await expect(adapter.connect('code')).rejects.toThrow('OAuth transport');
    await expect(adapter.publish({} as never)).rejects.toThrow('resumable upload transport');
    await expect(adapter.lookup('unknown')).rejects.toThrow('reconciliation transport');
    await expect(adapter.revoke('credential')).rejects.toThrow('revocation transport');
  });
});
