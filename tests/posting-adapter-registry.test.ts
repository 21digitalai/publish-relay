import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PostingAdapterList } from '../src/ui/posting-adapter-list.js';
import {
  getEnabledPostingAdapters,
  getPostingAdapter,
  POSTING_ADAPTERS,
} from '../src/ui/posting-adapter-registry.js';

describe('posting adapter registry', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('defines unique, self-rendering posting adapters', () => {
    expect(POSTING_ADAPTERS.map((adapter) => adapter.id)).toEqual([
      'x',
      'youtube',
      'linkedin',
      'facebook_page',
      'instagram',
      'tiktok',
    ]);
    expect(new Set(POSTING_ADAPTERS.map((adapter) => adapter.id)).size).toBe(
      POSTING_ADAPTERS.length,
    );
    for (const adapter of POSTING_ADAPTERS) {
      expect(adapter.label).not.toBe('');
      expect(adapter.icon.paths.length).toBeGreaterThan(0);
      expect(adapter.auth.startPath).toMatch(/^\/api\/oauth\//);
      expect(adapter.configuration.requiredBeforeConnect).toEqual([]);
    }
  });

  it('shows TikTok only when the server marked its provider runtime enabled', () => {
    expect(getEnabledPostingAdapters().some((adapter) => adapter.id === 'tiktok')).toBe(false);
    vi.stubGlobal('document', { body: { dataset: { tiktokEnabled: 'true' } } });
    expect(getEnabledPostingAdapters().some((adapter) => adapter.id === 'tiktok')).toBe(true);
    expect(getPostingAdapter('tiktok')?.auth.startPath).toBe('/api/oauth/tiktok');
  });

  it('removes disabled adapters without picker-specific filtering', () => {
    const adapters = POSTING_ADAPTERS.map((adapter) =>
      adapter.id === 'youtube' ? { ...adapter, enabled: false } : adapter,
    );
    expect(getEnabledPostingAdapters(adapters).map((adapter) => adapter.id)).toEqual([
      'x',
      'facebook_page',
      'instagram',
    ]);
    const markup = renderToStaticMarkup(
      createElement(PostingAdapterList, { adapters, onSelect: () => undefined }),
    );
    expect(markup).toContain('Publish posts and threads');
    expect(markup).not.toContain('Publish videos');
  });

  it('resolves account reconnect behavior from the same registry', () => {
    expect(getPostingAdapter('YouTube')?.auth.startPath).toBe('/api/oauth/youtube');
    expect(getPostingAdapter('Meta', 'facebook_page')?.auth.startPath).toBe(
      '/api/oauth/meta/facebook-pages',
    );
    expect(getPostingAdapter('Meta', 'instagram')?.auth.startPath).toBe('/api/oauth/instagram');
    expect(getPostingAdapter('Meta')).toBeUndefined();
    expect(getPostingAdapter('unknown')).toBeUndefined();
  });
});
