import { describe, expect, it } from 'vitest';

import type { PublishOutcome } from '../src/modules/providers/contract.js';
import { DeterministicFakeProviderAdapter } from '../src/modules/providers/fake-adapter.js';

const outcomes: PublishOutcome[] = [
  { status: 'published', externalPostId: 'post-1', externalUrl: 'https://example.test/post-1' },
  { status: 'accepted_pending', providerJobId: 'job-1' },
  { status: 'unknown', reconciliationKey: 'reconcile-1' },
  { status: 'failed', code: 'auth', message: 'auth' },
  { status: 'failed', code: 'rate_limit', message: 'rate', retryAfterSeconds: 30 },
  { status: 'failed', code: 'validation', message: 'validation' },
  { status: 'failed', code: 'transient', message: 'transient' },
  { status: 'failed', code: 'permanent', message: 'permanent' },
];

describe('provider adapter contract', () => {
  it('exposes adapter-owned technical metadata without commercial dimensions', () => {
    const adapter = new DeterministicFakeProviderAdapter([], {
      status: 'failed',
      code: 'validation',
      message: 'unused',
    });
    expect(adapter.capabilities).toEqual({
      providerFamily: 'fake',
      contentKinds: ['text', 'quote', 'article', 'video'],
      supportedMediaTypes: ['image/*', 'video/mp4'],
      accountTargetMode: 'single_account',
      dispatchMode: 'immediate_or_scheduled',
      verifiedLimits: {},
    });
    expect(JSON.stringify(adapter.capabilities)).not.toMatch(/plan|price|tier|entitlement/i);
  });

  it.each(outcomes)('returns typed $status outcomes without translation', async (outcome) => {
    const adapter = new DeterministicFakeProviderAdapter(
      [{ id: 'account-1', displayName: 'One' }],
      outcome,
    );
    const staged = await adapter.stage(
      'account-1',
      { kind: 'text', text: 'Exact payload', media: [] },
      'idem-1',
    );
    await expect(adapter.publish(staged)).resolves.toEqual(outcome);
  });

  it('preserves text, media, quote, and article payloads exactly and stages idempotently', async () => {
    const adapter = new DeterministicFakeProviderAdapter(
      [{ id: 'account-1', displayName: 'One' }],
      { status: 'accepted_pending', providerJobId: 'job-1' },
    );
    const article = {
      kind: 'article' as const,
      title: 'Title',
      body: 'Body that must not be truncated',
      media: [{ id: 'media-1', mimeType: 'image/png', altText: 'Alt' }],
    };
    const first = await adapter.stage('account-1', article, 'idem-article');
    const second = await adapter.stage(
      'account-1',
      { ...article, body: 'Different retry body' },
      'idem-article',
    );
    expect(first.content).toEqual(article);
    expect(second).toEqual(first);
    await expect(
      adapter.stage(
        'account-1',
        { kind: 'quote', text: 'Quote', quotedPostId: 'post-2', media: [] },
        'idem-quote',
      ),
    ).resolves.toMatchObject({ content: { kind: 'quote', quotedPostId: 'post-2' } });
  });

  it('stages video payloads without requiring unrelated text', async () => {
    const adapter = new DeterministicFakeProviderAdapter(
      [{ id: 'account-1', displayName: 'One' }],
      { status: 'accepted_pending', providerJobId: 'job-1' },
    );
    const video = {
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

    await expect(adapter.stage('account-1', video, 'idem-video')).resolves.toMatchObject({
      content: video,
    });
  });
});
