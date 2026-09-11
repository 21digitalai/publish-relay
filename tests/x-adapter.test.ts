import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import {
  publishXThread,
  XProviderAdapter,
  type XClient,
} from '../src/modules/providers/x-adapter.js';

function createClient() {
  const currentAccount = vi.fn<XClient['currentAccount']>();
  const createPost = vi.fn<XClient['createPost']>();
  const getPost = vi.fn<XClient['getPost']>();
  currentAccount.mockResolvedValue({ id: 'account-1', name: 'Daily', username: 'daily' });
  createPost.mockResolvedValue({ id: 'post-1', username: 'daily' });
  getPost.mockResolvedValue({ id: 'post-1', username: 'daily' });
  const client: XClient = {
    connect: vi.fn().mockResolvedValue({ credential: 'redacted' }),
    currentAccount,
    createPost,
    getPost,
    revoke: vi.fn().mockResolvedValue(undefined),
  };
  return { client, currentAccount, createPost, getPost };
}

describe('X provider adapter', () => {
  it('keeps discovery aligned with the sanitized OAuth1 identity fixture', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/x-identity-oauth1.json', import.meta.url), 'utf8'),
    ) as { authMode: string; status: number; data: { id: string; name: string; username: string } };
    const { client, currentAccount } = createClient();
    currentAccount.mockResolvedValue(fixture.data);
    await expect(new XProviderAdapter(client).discover('secret-not-serialized')).resolves.toEqual([
      { id: fixture.data.id, displayName: 'The Daily Viber (@TheDailyViber)' },
    ]);
    expect(fixture).toMatchObject({ authMode: 'OAuth 1.0a User Context', status: 200 });
  });

  it('maps text, media, and quote fields without silently transforming them', async () => {
    const { client, createPost } = createClient();
    const adapter = new XProviderAdapter(client);
    const staged = await adapter.stage(
      'account-1',
      {
        kind: 'quote',
        text: 'Exact text',
        quotedPostId: 'quoted-1',
        media: [{ id: 'media-1', mimeType: 'image/png' }],
      },
      'idem-1',
    );
    await expect(adapter.publish(staged)).resolves.toEqual({
      status: 'published',
      externalPostId: 'post-1',
      externalUrl: 'https://x.com/daily/status/post-1',
    });
    expect(createPost).toHaveBeenCalledWith({
      text: 'Exact text',
      mediaIds: ['media-1'],
      quoteTweetId: 'quoted-1',
      idempotencyKey: 'idem-1',
    });
  });

  it('keeps unverified articles explicit and classifies provider failures', async () => {
    const { client, createPost } = createClient();
    const adapter = new XProviderAdapter(client);
    await expect(
      adapter.stage(
        'account-1',
        { kind: 'article', title: 'Title', body: 'Body', media: [] },
        'article-1',
      ),
    ).rejects.toThrow('not verified');
    createPost.mockRejectedValue({
      status: 429,
      message: 'Rate limited',
      retryAfterSeconds: 30,
    });
    const staged = await adapter.stage(
      'account-1',
      { kind: 'text', text: 'Text', media: [] },
      'text-1',
    );
    await expect(adapter.publish(staged)).resolves.toEqual({
      status: 'failed',
      code: 'rate_limit',
      message: 'Rate limited',
      retryAfterSeconds: 30,
    });
  });

  it('rejects media counts above the evidence-backed X post limit', async () => {
    const { client, createPost } = createClient();
    const adapter = new XProviderAdapter(client);
    await expect(
      adapter.stage(
        'account-1',
        {
          kind: 'text',
          text: 'Too many attachments',
          media: Array.from({ length: 5 }, (_, index) => ({
            id: `media-${String(index + 1)}`,
            mimeType: 'image/png',
          })),
        },
        'too-many-media',
      ),
    ).rejects.toThrow('at most 4 media attachments');
    expect(createPost).not.toHaveBeenCalled();
  });

  it('looks up known posts and preserves unknown outcomes for reconciliation', async () => {
    const { client, getPost } = createClient();
    const adapter = new XProviderAdapter(client);
    await expect(adapter.lookup('x:post-1')).resolves.toMatchObject({
      status: 'published',
      externalPostId: 'post-1',
    });
    getPost.mockResolvedValue(null);
    await expect(adapter.lookup('x:post-2')).resolves.toEqual({
      status: 'unknown',
      reconciliationKey: 'x:post-2',
    });
  });
});

describe('X native thread publishing', () => {
  it('publishes ordered replies with media only on their intended part', async () => {
    const createPost = vi
      .fn()
      .mockResolvedValueOnce({ id: 'root-1', username: 'dailyviber' })
      .mockResolvedValueOnce({ id: 'reply-1', username: 'dailyviber' });
    const client = { createPost } as unknown as XClient;
    const saved: string[] = [];

    const result = await publishXThread(
      client,
      [
        { text: 'Article content', mediaIds: ['image-1'] },
        { text: 'Here’s the repo: https://github.com/example/repo', mediaIds: [] },
      ],
      'job-1',
      [],
      (part) => {
        saved.push(part.externalPostId);
        return Promise.resolve();
      },
    );

    expect(createPost).toHaveBeenNthCalledWith(1, {
      text: 'Article content',
      mediaIds: ['image-1'],
      idempotencyKey: 'job-1:part:0',
    });
    expect(createPost).toHaveBeenNthCalledWith(2, {
      text: 'Here’s the repo: https://github.com/example/repo',
      mediaIds: [],
      replyToTweetId: 'root-1',
      idempotencyKey: 'job-1:part:1',
    });
    expect(saved).toEqual(['root-1', 'reply-1']);
    expect(result.map((part) => part.externalPostId)).toEqual(['root-1', 'reply-1']);
  });

  it('resumes after a persisted root without publishing it again', async () => {
    const createPost = vi.fn().mockResolvedValue({ id: 'reply-1', username: 'dailyviber' });

    await publishXThread(
      { createPost } as unknown as XClient,
      [
        { text: 'Article content', mediaIds: ['image-1'] },
        { text: 'Here’s the repo: https://github.com/example/repo', mediaIds: [] },
      ],
      'job-1',
      [
        {
          position: 0,
          externalPostId: 'root-1',
          externalUrl: 'https://x.com/dailyviber/status/root-1',
        },
      ],
    );

    expect(createPost).toHaveBeenCalledOnce();
    expect(createPost).toHaveBeenCalledWith(
      expect.objectContaining({ replyToTweetId: 'root-1', idempotencyKey: 'job-1:part:1' }),
    );
  });

  it('stops at the failed part after persisting the successful prefix', async () => {
    const createPost = vi
      .fn()
      .mockResolvedValueOnce({ id: 'root-1', username: 'dailyviber' })
      .mockRejectedValueOnce(new Error('provider unavailable'));
    const saved: string[] = [];

    await expect(
      publishXThread(
        { createPost } as unknown as XClient,
        [
          { text: 'Root', mediaIds: [] },
          { text: 'Reply', mediaIds: [] },
        ],
        'job-1',
        [],
        (part) => {
          saved.push(part.externalPostId);
          return Promise.resolve();
        },
      ),
    ).rejects.toThrow('provider unavailable');
    expect(saved).toEqual(['root-1']);
  });

  it('records durable dispatch intent before calling X', async () => {
    const events: string[] = [];
    const createPost = vi.fn(() => {
      events.push('provider');
      return Promise.resolve({ id: 'root-1', username: 'dailyviber' });
    });

    await publishXThread(
      { createPost } as unknown as XClient,
      [{ text: 'Root', mediaIds: [] }],
      'job-1',
      [],
      undefined,
      (_position, key) => {
        events.push(`intent:${key}`);
        return Promise.resolve();
      },
    );

    expect(events).toEqual(['intent:job-1:part:0', 'provider']);
  });

  it('does not call X when a prior dispatch intent is ambiguous', async () => {
    const createPost = vi.fn();
    await expect(
      publishXThread(
        { createPost } as unknown as XClient,
        [{ text: 'Root', mediaIds: [] }],
        'job-1',
        [],
        undefined,
        () => Promise.reject(new Error('ambiguous prior dispatch')),
      ),
    ).rejects.toThrow('ambiguous prior dispatch');
    expect(createPost).not.toHaveBeenCalled();
  });

  it('retains the ambiguous part correlation when X create has an unknown outcome', async () => {
    const unknown = Object.assign(new Error('connection lost'), { outcomeUnknown: true });
    await expect(
      publishXThread(
        { createPost: vi.fn(() => Promise.reject(unknown)) } as unknown as XClient,
        [{ text: 'Root', mediaIds: [] }],
        'job-1',
      ),
    ).rejects.toMatchObject({
      outcomeUnknown: true,
      reconciliationKey: 'x:manual:job-1:part:0',
    });
  });
});
