import { describe, expect, it } from 'vitest';
import { isPublicationAdapterEnabled } from '../src/modules/providers/publication-adapter-availability.js';

describe('publication adapter availability across connection methods', () => {
  it('enables Unified and legacy Instagram detail and retry identities under Instagram', () => {
    for (const provider of [
      'instagram_unified_login',
      'INSTAGRAM_UNIFIED_LOGIN',
      'instagram_login',
      'INSTAGRAM_LOGIN',
      'instagram',
    ]) {
      expect(isPublicationAdapterEnabled(new Set(['facebook_page', 'instagram']), provider)).toBe(
        true,
      );
    }
  });
  it('keeps Instagram controls disabled when only Facebook is enabled', () => {
    for (const provider of ['instagram_unified_login', 'instagram_login', 'instagram']) {
      expect(isPublicationAdapterEnabled(new Set(['facebook_page']), provider)).toBe(false);
    }
  });
  it('normalizes display casing without enabling unrelated adapters', () => {
    expect(isPublicationAdapterEnabled(new Set(['x']), 'X')).toBe(true);
    expect(isPublicationAdapterEnabled(new Set(['x']), 'YOUTUBE')).toBe(false);
    expect(isPublicationAdapterEnabled(new Set(), 'instagram_unified_login')).toBe(false);
    expect(isPublicationAdapterEnabled(undefined, 'instagram_unified_login')).toBe(true);
  });
});
