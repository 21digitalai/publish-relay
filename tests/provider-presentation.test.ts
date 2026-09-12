import { describe, expect, it } from 'vitest';

import { externalResultLabel, providerDisplayName } from '../src/ui/provider-presentation.js';

describe('provider presentation', () => {
  it('renders the YouTube external result label', () => {
    expect(externalResultLabel('YOUTUBE')).toBe('View on YouTube');
  });

  it('keeps ordered X thread labels', () => {
    expect(externalResultLabel('X', 0)).toBe('View post 1 on X');
    expect(externalResultLabel('X', 1)).toBe('View post 2 on X');
  });

  it('uses a readable fallback for future providers', () => {
    expect(providerDisplayName('bluesky')).toBe('bluesky');
    expect(externalResultLabel('bluesky')).toBe('View on bluesky');
  });
});
