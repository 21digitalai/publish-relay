/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';

import {
  FacebookPublishingAdapter,
  type FacebookArtifact,
  type FacebookArtifactStore,
} from '../src/modules/providers/facebook-adapter.js';
import { FacebookHttpClient } from '../src/modules/providers/facebook-http-client.js';

class MemoryArtifacts implements FacebookArtifactStore {
  public readonly values = new Map<string, FacebookArtifact>();
  public async ensure(input: { key: string }) {
    const value = this.values.get(input.key) ?? { key: input.key, phase: 'initialized' as const };
    this.values.set(input.key, value);
    return value;
  }
  public async update(key: string, update: Omit<FacebookArtifact, 'key'>) {
    const current = this.values.get(key);
    if (!current) throw new Error('artifact missing');
    const next = { ...current, ...update };
    this.values.set(key, next);
    return next;
  }
}

function response(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function adapter(fetch: typeof globalThis.fetch, artifacts = new MemoryArtifacts()) {
  return {
    instance: new FacebookPublishingAdapter({
      client: new FacebookHttpClient({ graphVersion: 'v23.0', fetch }),
      artifacts,
      accessToken: () => Promise.resolve('secret-token'),
      mediaUrl: () =>
        Promise.resolve('https://relay.example/provider-media/instagram?token=opaque'),
    }),
    artifacts,
  };
}

describe('FacebookPublishingAdapter', () => {
  it('publishes a canonical link and persists the authoritative permalink', async () => {
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(new URLSearchParams(init.body as string).get('link')).toBe(
          'https://example.com/story',
        );
        return response({ id: 'page_1' });
      }
      expect(new URL(url).searchParams.get('fields')).toBe('permalink_url');
      return response({ permalink_url: 'https://facebook.com/page/posts/1' });
    });
    const { instance, artifacts } = adapter(fetch as typeof globalThis.fetch);
    const staged = await instance.stage(
      'page',
      { kind: 'link', text: 'Read this', url: 'https://example.com/story', media: [] },
      'job',
    );
    await expect(instance.publish(staged)).resolves.toEqual({
      status: 'published',
      externalPostId: 'page_1',
      externalUrl: 'https://facebook.com/page/posts/1',
    });
    expect(artifacts.values.get('facebook_page:job:create')).toMatchObject({
      phase: 'permalink_resolved',
      evidence: { permalinkSource: 'authoritative' },
    });
  });

  it('publishes one JPEG through the Page photos endpoint', async () => {
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(new URL(url).pathname.endsWith('/page/photos')).toBe(true);
        const body = new URLSearchParams(init.body as string);
        expect(body.get('url')).toContain('token=opaque');
        expect(body.get('caption')).toBe('Photo');
        return response({ id: 'photo_1' });
      }
      return response({ permalink_url: 'https://facebook.com/photo/1' });
    });
    const { instance } = adapter(fetch as typeof globalThis.fetch);
    await expect(
      instance.publish(
        await instance.stage(
          'page',
          { kind: 'text', text: 'Photo', media: [{ id: 'media', mimeType: 'image/jpeg' }] },
          'job',
        ),
      ),
    ).resolves.toMatchObject({ status: 'published', externalPostId: 'photo_1' });
  });

  it.each([
    { kind: 'text' as const, text: 'text only', media: [] },
    {
      kind: 'text' as const,
      text: 'many',
      media: [
        { id: 'one', mimeType: 'image/jpeg' },
        { id: 'two', mimeType: 'image/png' },
      ],
    },
    { kind: 'link' as const, text: '', url: 'http://unsafe.example', media: [] as [] },
    { kind: 'link' as const, text: '', url: 'not a url', media: [] as [] },
    {
      kind: 'video' as const,
      text: 'video',
      media: [{ id: 'video', mimeType: 'video/mp4' }] as [{ id: string; mimeType: string }],
      providerOptions: {
        youtube: {
          schemaVersion: 1 as const,
          title: 'Video',
          privacyStatus: 'private' as const,
          madeForKids: false,
          notifySubscribers: false,
        },
      },
    },
  ])('rejects unsupported phase-one content', async (content) => {
    const { instance } = adapter(vi.fn() as typeof globalThis.fetch);
    await expect(instance.stage('page', content, 'job')).rejects.toThrow();
  });

  it('rejects an unavailable destination before staging', async () => {
    const { instance } = adapter(vi.fn() as typeof globalThis.fetch);
    await expect(
      instance.stage('', { kind: 'link', text: '', url: 'https://example.com', media: [] }, 'job'),
    ).rejects.toThrow('destination is unavailable');
  });

  it('holds a lost create response and never writes twice', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('timeout');
    });
    const { instance } = adapter(fetch);
    const staged = await instance.stage(
      'page',
      { kind: 'link', text: '', url: 'https://example.com', media: [] },
      'job',
    );
    await expect(instance.publish(staged)).resolves.toEqual({
      status: 'unknown',
      reconciliationKey: 'facebook_page:job:create',
    });
    await expect(instance.publish(staged)).resolves.toMatchObject({ status: 'unknown' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([{ body: {} }, { body: { id: 42 } }, { body: null }])(
    'holds a malformed successful create response and never writes twice: $body',
    async ({ body }) => {
      const fetch = vi.fn(async () => response(body));
      const { instance } = adapter(fetch);
      const staged = await instance.stage(
        'page',
        { kind: 'link', text: '', url: 'https://example.com', media: [] },
        'job',
      );

      await expect(instance.publish(staged)).resolves.toEqual({
        status: 'unknown',
        reconciliationKey: 'facebook_page:job:create',
      });
      await expect(instance.publish(staged)).resolves.toMatchObject({ status: 'unknown' });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('uses a labeled derived link when authoritative permalink lookup fails', async () => {
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) =>
      init?.method === 'POST' ? response({ id: 'page_2' }) : response({}, 404),
    );
    const { instance, artifacts } = adapter(fetch as typeof globalThis.fetch);
    const outcome = await instance.publish(
      await instance.stage(
        'page',
        { kind: 'link', text: '', url: 'https://example.com', media: [] },
        'job',
      ),
    );
    expect(outcome).toEqual({
      status: 'published',
      externalPostId: 'page_2',
      externalUrl: 'https://www.facebook.com/page_2',
    });
    expect(artifacts.values.get('facebook_page:job:create')?.evidence).toMatchObject({
      permalinkSource: 'derived',
    });
  });

  it('resumes from a durable provider ID without replaying the create request', async () => {
    const artifacts = new MemoryArtifacts();
    artifacts.values.set('facebook_page:job:create', {
      key: 'facebook_page:job:create',
      phase: 'provider_result',
      externalObjectId: 'page_3',
    });
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.method).toBeUndefined();
      return response({ permalink_url: 'https://facebook.com/page/posts/3' });
    });
    const { instance } = adapter(fetch as typeof globalThis.fetch, artifacts);

    await expect(
      instance.publish(
        await instance.stage(
          'page',
          { kind: 'link', text: '', url: 'https://example.com', media: [] },
          'job',
        ),
      ),
    ).resolves.toEqual({
      status: 'published',
      externalPostId: 'page_3',
      externalUrl: 'https://facebook.com/page/posts/3',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 401, code: 190, expected: 'auth' },
    { status: 403, code: 10, expected: 'auth' },
    { status: 400, code: 100, expected: 'validation' },
  ])(
    'maps provider failure $code to $expected without retrying',
    async ({ status, code, expected }) => {
      const fetch = vi.fn(async () =>
        response({ error: { code, error_subcode: 7, fbtrace_id: 'trace' } }, status),
      );
      const { instance } = adapter(fetch);
      await expect(
        instance.publish(
          await instance.stage(
            'page',
            { kind: 'link', text: '', url: 'https://example.com', media: [] },
            'job',
          ),
        ),
      ).resolves.toMatchObject({ status: 'failed', code: expected });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('maps bounded Graph evidence without retaining response bodies or tokens', async () => {
    const fetch = vi.fn(async () =>
      response(
        { error: { code: 4, error_subcode: 99, is_transient: true, fbtrace_id: 'trace' } },
        429,
        {
          'retry-after': '30',
          'x-app-usage': '{"call_count":50}',
          'x-page-usage': '{"call_count":100}',
        },
      ),
    );
    const { instance, artifacts } = adapter(fetch);
    const outcome = await instance.publish(
      await instance.stage(
        'page',
        { kind: 'link', text: '', url: 'https://example.com', media: [] },
        'job',
      ),
    );
    expect(outcome).toMatchObject({ status: 'failed', code: 'rate_limit', retryAfterSeconds: 30 });
    expect(artifacts.values.get('facebook_page:job:create')?.evidence).toEqual({
      kind: 'rate_limit',
      status: 429,
      code: 4,
      subcode: 99,
      isTransient: true,
      retryAfterSeconds: 30,
      traceId: 'trace',
      appUsage: '{"call_count":50}',
      pageUsage: '{"call_count":100}',
    });
  });
});
