import { describe, expect, it } from 'vitest';

import {
  getEnabledPostingAdapters,
  getPostingAdapter,
  POSTING_ADAPTERS,
} from '../src/ui/posting-adapter-registry.js';

describe('posting adapter registry', () => {
  it('defines unique, self-rendering X and YouTube adapters', () => {
    expect(POSTING_ADAPTERS.map((adapter) => adapter.id)).toEqual(['x', 'youtube']);
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

  it('removes disabled adapters without picker-specific filtering', () => {
    const adapters = POSTING_ADAPTERS.map((adapter) =>
      adapter.id === 'youtube' ? { ...adapter, enabled: false } : adapter,
    );
    expect(getEnabledPostingAdapters(adapters).map((adapter) => adapter.id)).toEqual(['x']);
  });

  it('resolves account reconnect behavior from the same registry', () => {
    expect(getPostingAdapter('YouTube')?.auth.startPath).toBe('/api/oauth/youtube');
    expect(getPostingAdapter('unknown')).toBeUndefined();
  });
});
