import { describe, expect, it } from 'vitest';

import { resolveYouTubeSettings } from '../src/modules/providers/youtube-settings.js';

describe('resolveYouTubeSettings', () => {
  it('resolves destination defaults and sparse request overrides into a complete snapshot', () => {
    expect(
      resolveYouTubeSettings(
        {
          privacyStatus: 'unlisted',
          madeForKids: false,
          notifySubscribers: true,
          tags: ['default'],
          categoryId: '22',
        },
        { schemaVersion: 1, title: 'Release', privacyStatus: 'public', tags: ['launch'] },
      ),
    ).toEqual({
      schemaVersion: 1,
      title: 'Release',
      privacyStatus: 'public',
      madeForKids: false,
      notifySubscribers: true,
      tags: ['launch'],
      categoryId: '22',
    });
  });

  it('uses approved product defaults without inventing optional metadata', () => {
    expect(
      resolveYouTubeSettings({ madeForKids: true }, { schemaVersion: 1, title: 'Release' }),
    ).toEqual({
      schemaVersion: 1,
      title: 'Release',
      privacyStatus: 'public',
      madeForKids: true,
      notifySubscribers: false,
    });
  });

  it('requires madeForKids in the resolved settings', () => {
    expect(() => resolveYouTubeSettings({}, { schemaVersion: 1, title: 'Release' })).toThrow(
      'YouTube madeForKids requires a destination default or request override',
    );
  });
});
