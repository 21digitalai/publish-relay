import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  buildSocialGodParity,
  scheduleSocialGodSnapshot,
} from '../src/modules/parity/social-god.js';

describe('Social God dry-run parity', () => {
  it('maps legacy Postiz thread parts into the provider-supported X Premium text contract', () => {
    const report = buildSocialGodParity({
      packages: [
        {
          package_id: 'thread-1',
          article: { title: '' },
          platform_renders: { x_premium_long: { posts: ['Opening', 'Closing'] } },
        },
      ],
      schedule_records: [
        {
          id: 6,
          package_id: 'thread-1',
          platform: 'x_premium_long',
          scheduled_for_utc: '2026-09-02T12:00:00.000Z',
        },
      ],
      account_map: { x_premium_long: randomUUID() },
    });

    expect(report.records[0]?.request?.body.content).toEqual({
      kind: 'text',
      text: 'Opening\n\nClosing',
    });
  });

  it('maps text, quote, thread, media, account, schedule and result fields without credentials', () => {
    const accountId = randomUUID();
    const mediaId = randomUUID();
    const report = buildSocialGodParity({
      packages: [
        {
          package_id: 'daily-1',
          postiz_notes: { cms_item_id: 42 },
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
          item_id: 42,
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
    expect(report.records[0]?.source.packageId).toBe('daily-1');
  });

  it('joins a production-shaped schedule record through an explicit item-to-package map', () => {
    const report = buildSocialGodParity({
      packages: [
        {
          package_id: 'daily-2',
          article: { title: 'Mapped', body_text: 'Mapped body' },
          platform_renders: { x_premium_long: { text: 'Mapped post' } },
        },
      ],
      schedule_records: [
        {
          id: 8,
          item_id: 84,
          platform: 'x_premium_long',
          scheduled_for_utc: '2026-09-03T13:00:00.000Z',
          metadata: { postiz_output: {}, adapter_version: 'x-postiz-v1' },
        },
      ],
      account_map: { x_premium_long: randomUUID() },
      item_package_map: { '84': 'daily-2' },
    });

    expect(report.records[0]?.source.packageId).toBe('daily-2');
    expect(report.records[0]?.request?.body.content).toEqual({ kind: 'text', text: 'Mapped post' });
    expect(report.records[0]?.parity).toEqual({ matched: true, gaps: [] });
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

describe('Social God Publish Relay scheduling', () => {
  const snapshot = (accountId: string) => ({
    packages: [
      {
        package_id: 'daily-3',
        postiz_notes: { cms_item_id: 91 },
        article: { title: 'Relay', body_text: 'Relay body' },
        platform_renders: { x_premium_long: { text: 'Relay post' } },
      },
    ],
    schedule_records: [
      {
        id: 9,
        item_id: 91,
        platform: 'x_premium_long',
        scheduled_for_utc: '2026-09-04T13:00:00.000Z',
      },
    ],
    account_map: { x_premium_long: accountId },
  });

  it('preflights the workspace and reuses the exact idempotency key on replay', async () => {
    const accountId = randomUUID();
    const postId = randomUUID();
    const revisionId = randomUUID();
    const jobId = randomUUID();
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = (url: string | URL | Request, init?: RequestInit) => {
      const urlText = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      calls.push({ url: urlText, ...(init ? { init } : {}) });
      return Promise.resolve(
        urlText.endsWith('/api/v1/account')
          ? Response.json({
              data: { workspaceId: 'workspace-1', workspaceLabel: 'Daily Vibe' },
            })
          : Response.json({
              data: {
                id: postId,
                revisionId,
                links: { self: `/api/v1/posts/${postId}`, jobs: [`/api/v1/jobs/${jobId}`] },
              },
            }),
      );
    };
    const options = {
      target: 'publish-relay' as const,
      baseUrl: 'http://relay.test',
      workspace: 'workspace-1',
      apiKey: 'test-only',
      fetcher,
    };

    await scheduleSocialGodSnapshot(snapshot(accountId), options);
    await scheduleSocialGodSnapshot(snapshot(accountId), options);

    const mutations = calls.filter((call) => call.init?.method === 'POST');
    expect(mutations).toHaveLength(2);
    expect(new Headers(mutations[0]?.init?.headers).get('idempotency-key')).toBe(
      new Headers(mutations[1]?.init?.headers).get('idempotency-key'),
    );
    const requestBody = mutations[0]?.init?.body;
    expect(typeof requestBody).toBe('string');
    expect(JSON.parse(typeof requestBody === 'string' ? requestBody : '')).toMatchObject({
      providerAccountIds: [accountId],
      scheduledAt: '2026-09-04T13:00:00.000Z',
    });
  });

  it('fails the complete batch before network access when a join is unresolved', async () => {
    const fetcher = vi.fn();
    await expect(
      scheduleSocialGodSnapshot(
        { packages: [], schedule_records: [{ id: 10 }], account_map: {} },
        {
          target: 'publish-relay',
          baseUrl: 'http://relay.test',
          workspace: 'workspace-1',
          apiKey: 'test-only',
          fetcher,
        },
      ),
    ).rejects.toThrow('unresolved mappings');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
