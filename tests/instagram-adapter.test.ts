/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unnecessary-type-assertion */
import { describe, expect, it, vi } from 'vitest';

import {
  InstagramPublishingAdapter,
  type InstagramArtifact,
  type InstagramArtifactStore,
} from '../src/modules/providers/instagram-adapter.js';
import { InstagramHttpClient } from '../src/modules/providers/instagram-http-client.js';
import { getInstagramRetryAt } from '../src/modules/providers/instagram-dispatch.service.js';

class MemoryArtifacts implements InstagramArtifactStore {
  public readonly values = new Map<string, InstagramArtifact>();

  public async ensure(input: { key: string; kind: InstagramArtifact['kind'] }) {
    const current = this.values.get(input.key) ?? {
      key: input.key,
      kind: input.kind,
      phase: 'initialized' as const,
    };
    this.values.set(input.key, current);
    return current;
  }

  public async update(key: string, update: Omit<InstagramArtifact, 'key' | 'kind'>) {
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

function content(count: number) {
  return {
    kind: 'text' as const,
    text: 'Caption',
    media: Array.from({ length: count }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      mimeType: 'image/jpeg',
    })),
  };
}

describe('InstagramPublishingAdapter', () => {
  it('bounds transient and provider-directed retry timing', () => {
    const now = new Date('2026-09-17T16:00:00Z');
    expect(getInstagramRetryAt({ status: 'failed', code: 'transient' }, now)).toEqual(
      new Date('2026-09-17T16:00:05Z'),
    );
    expect(
      getInstagramRetryAt({ status: 'failed', code: 'rate_limit', retryAfterSeconds: 3_600 }, now),
    ).toEqual(new Date('2026-09-17T16:05:00Z'));
    expect(getInstagramRetryAt({ status: 'failed', code: 'auth' }, now)).toBeUndefined();
  });
  it.each([1, 2, 10])(
    'publishes and resumes a %i-image payload from durable artifacts',
    async (count) => {
      let nextId = 0;
      const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (init?.method === 'POST' && path.endsWith('/media_publish'))
          return response({ id: 'media-1' });
        if (init?.method === 'POST' && path.endsWith('/media'))
          return response({ id: `container-${nextId++}` });
        if (path.endsWith('/media-1'))
          return response({ id: 'media-1', permalink: 'https://instagram.com/p/1' });
        return response({ status_code: 'FINISHED' });
      });
      const artifacts = new MemoryArtifacts();
      const adapter = new InstagramPublishingAdapter({
        client: new InstagramHttpClient({
          graphVersion: 'v23.0',
          fetch: fetch as typeof globalThis.fetch,
        }),
        artifacts,
        accessToken: async () => 'token',
        mediaUrl: async (mediaId) => `https://relay.example/provider-media/${mediaId}?token=opaque`,
      });
      const staged = await adapter.stage('ig-1', content(count), 'job-1');
      await expect(adapter.publish(staged)).resolves.toEqual({
        status: 'published',
        externalPostId: 'media-1',
        externalUrl: 'https://instagram.com/p/1',
      });
      const callsAfterFirstPublish = fetch.mock.calls.length;
      await expect(adapter.publish(staged)).resolves.toMatchObject({ status: 'published' });
      expect(fetch).toHaveBeenCalledTimes(callsAfterFirstPublish);
    },
  );

  it.each([0, 11])('rejects an invalid image count of %i', async (count) => {
    const adapter = new InstagramPublishingAdapter({
      client: new InstagramHttpClient({ graphVersion: 'v23.0' }),
      artifacts: new MemoryArtifacts(),
      accessToken: async () => 'token',
      mediaUrl: async () => 'https://relay.example/media',
    });
    await expect(adapter.stage('ig-1', content(count), 'job')).rejects.toThrow();
  });

  it('holds an ambiguous publish response for reconciliation instead of retrying', async () => {
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (init?.method === 'POST' && path.endsWith('/media_publish'))
        throw new TypeError('timeout');
      if (init?.method === 'POST') return response({ id: 'container-1' });
      return response({ status_code: 'FINISHED' });
    });
    const artifacts = new MemoryArtifacts();
    const adapter = new InstagramPublishingAdapter({
      client: new InstagramHttpClient({
        graphVersion: 'v23.0',
        fetch: fetch as typeof globalThis.fetch,
      }),
      artifacts,
      accessToken: async () => 'token',
      mediaUrl: async () => 'https://relay.example/media',
    });
    const staged = await adapter.stage('ig-1', content(1), 'job');
    await expect(adapter.publish(staged)).resolves.toEqual({
      status: 'unknown',
      reconciliationKey: 'instagram:job:publish',
    });
    await expect(adapter.publish(staged)).resolves.toEqual({
      status: 'unknown',
      reconciliationKey: 'instagram:job:publish',
    });
    expect(
      fetch.mock.calls.filter(
        ([url, init]) =>
          init?.method === 'POST' && new URL(url).pathname.endsWith('/media_publish'),
      ),
    ).toHaveLength(1);
  });

  it('holds an ambiguous child-container creation without recreating it', async () => {
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (init?.method === 'POST' && path.endsWith('/media')) throw new TypeError('timeout');
      return response({ status_code: 'FINISHED' });
    });
    const adapter = new InstagramPublishingAdapter({
      client: new InstagramHttpClient({
        graphVersion: 'v23.0',
        fetch: fetch as typeof globalThis.fetch,
      }),
      artifacts: new MemoryArtifacts(),
      accessToken: async () => 'token',
      mediaUrl: async () => 'https://relay.example/media',
    });
    const staged = await adapter.stage('ig-1', content(1), 'job');
    await expect(adapter.publish(staged)).resolves.toEqual({
      status: 'unknown',
      reconciliationKey: 'instagram:job:child:0',
    });
    await expect(adapter.publish(staged)).resolves.toEqual({
      status: 'unknown',
      reconciliationKey: 'instagram:job:child:0',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the exact child artifact key after a restart at the create boundary', async () => {
    const artifacts = new MemoryArtifacts();
    artifacts.values.set('instagram:job:child:0', {
      key: 'instagram:job:child:0',
      kind: 'child',
      phase: 'request_started',
    });
    const fetch = vi.fn();
    const adapter = new InstagramPublishingAdapter({
      client: new InstagramHttpClient({
        graphVersion: 'v23.0',
        fetch: fetch as typeof globalThis.fetch,
      }),
      artifacts,
      accessToken: async () => 'token',
      mediaUrl: async () => 'https://relay.example/media',
    });

    await expect(adapter.publish(await adapter.stage('ig-1', content(1), 'job'))).resolves.toEqual({
      status: 'unknown',
      reconciliationKey: 'instagram:job:child:0',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the exact parent artifact key after a restart at the create boundary', async () => {
    const artifacts = new MemoryArtifacts();
    for (const [index, id] of ['child-1', 'child-2'].entries())
      artifacts.values.set(`instagram:job:child:${index}`, {
        key: `instagram:job:child:${index}`,
        kind: 'child',
        phase: 'finished',
        externalObjectId: id,
      });
    artifacts.values.set('instagram:job:parent', {
      key: 'instagram:job:parent',
      kind: 'parent',
      phase: 'request_started',
    });
    const fetch = vi.fn();
    const adapter = new InstagramPublishingAdapter({
      client: new InstagramHttpClient({
        graphVersion: 'v23.0',
        fetch: fetch as typeof globalThis.fetch,
      }),
      artifacts,
      accessToken: async () => 'token',
      mediaUrl: async () => 'https://relay.example/media',
    });

    await expect(adapter.publish(await adapter.stage('ig-1', content(2), 'job'))).resolves.toEqual({
      status: 'unknown',
      reconciliationKey: 'instagram:job:parent',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps bounded Graph evidence without exposing provider bodies', async () => {
    const fetch = vi.fn(async () =>
      response(
        { error: { code: 4, error_subcode: 99, is_transient: true, fbtrace_id: 'trace' } },
        429,
        { 'retry-after': '30', 'x-app-usage': '{"call_count":100}' },
      ),
    );
    const client = new InstagramHttpClient({
      graphVersion: 'v23.0',
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(client.getContainerStatus('container', 'token')).rejects.toMatchObject({
      evidence: {
        kind: 'rate_limit',
        code: 4,
        subcode: 99,
        retryAfterSeconds: 30,
        traceId: 'trace',
      },
    });
  });
});
