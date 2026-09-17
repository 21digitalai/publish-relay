import { describe, expect, it } from 'vitest';

import { PublishingAdapterRegistry } from '../src/modules/providers/adapter-registry.js';
import type { PublishingAdapter } from '../src/modules/providers/contract.js';

function adapter(destinationProvider: 'x' | 'youtube'): PublishingAdapter {
  return { destinationProvider } as PublishingAdapter;
}

describe('publishing adapter registry', () => {
  it('selects publishing behavior by destination provider', () => {
    const registry = new PublishingAdapterRegistry([adapter('x'), adapter('youtube')]);
    expect(registry.get('youtube').destinationProvider).toBe('youtube');
  });

  it('rejects duplicate destination registrations', () => {
    expect(() => new PublishingAdapterRegistry([adapter('x'), adapter('x')])).toThrow(
      'Publishing adapter already registered: x',
    );
  });

  it('fails closed for an unregistered destination', () => {
    const registry = new PublishingAdapterRegistry([adapter('x')]);
    expect(() => registry.get('instagram')).toThrow(
      'Publishing adapter is not registered: instagram',
    );
  });
});
