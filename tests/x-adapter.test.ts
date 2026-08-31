import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import { XProviderAdapter, type XClient } from '../src/modules/providers/x-adapter.js';

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
