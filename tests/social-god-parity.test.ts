import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildSocialGodParity } from '../src/modules/parity/social-god.js';

describe('Social God dry-run parity', () => {
  it('maps text, quote, thread, media, account, schedule and result fields without credentials', () => {
    const accountId = randomUUID();
    const mediaId = randomUUID();
    const report = buildSocialGodParity({
      packages: [
        {
          package_id: 'daily-1',
          article: { title: 'Title', body_text: 'Body' },
          platform_renders: {
            x_premium_long: {
              text: 'Comment',
              quote_url: 'https://x.com/a/status/1',
              media: ['https://cdn.test/a.png'],
            },
          },
        },
      ],
      schedule_records: [
        {
          id: 7,
          package_id: 'daily-1',
          platform: 'x_premium_long',
          scheduled_for_utc: '2026-09-02T13:00:00.000Z',
          state: 'published',
          external_ids: ['post-1'],
          release_url: 'https://x.com/a/status/2',
        },
      ],
      account_map: { x_premium_long: accountId },
      media_map: { 'https://cdn.test/a.png': mediaId },
    });
    expect(report.credentialsUsed).toBe(false);
    expect(report.externalWritesBlocked).toBe(true);
    expect(report.counts).toEqual({ packages: 1, scheduleRecords: 1, matched: 1, gaps: 0 });
    expect(report.records[0]?.request?.body).toMatchObject({
      content: { kind: 'quote', quotedPostId: 'https://x.com/a/status/1' },
      mediaIds: [mediaId],
      providerAccountIds: [accountId],
    });
    expect(report.records[0]?.result.externalUrl).toBe('https://x.com/a/status/2');
  });

  it('emits exact bounded gaps instead of inventing mappings', () => {
    const report = buildSocialGodParity({
      packages: [],
      schedule_records: [{ id: 'r1', package_id: 'missing' }],
      account_map: {},
    });
    expect(report.counts.gaps).toBe(1);
    expect(report.records[0]?.request).toBeNull();
    expect(report.records[0]?.parity.gaps).toEqual(
      expect.arrayContaining([
        'package not found: missing',
        'target account not mapped for platform: x_premium_long',
        'scheduled_at missing',
      ]),
    );
  });
});
