import { describe, expect, it } from 'vitest';

import { PublishingAdapterRegistry } from '../src/modules/providers/adapter-registry.js';
import { runDestinationDispatchCycle } from '../src/modules/providers/destination-dispatch-runtime.js';
import type { PublishingAdapter } from '../src/modules/providers/contract.js';

function adapter(destinationProvider: 'x' | 'youtube' | 'facebook_page'): PublishingAdapter {
  return { destinationProvider } as PublishingAdapter;
}

describe('publishing adapter registry', () => {
  it('selects publishing behavior by destination provider', () => {
    const registry = new PublishingAdapterRegistry([
      adapter('x'),
      adapter('youtube'),
      adapter('facebook_page'),
    ]);
    expect(registry.get('youtube').destinationProvider).toBe('youtube');
    expect(registry.get('facebook_page').destinationProvider).toBe('facebook_page');
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

  it('routes the production worker cycle through destination-keyed adapters', async () => {
    const calls: string[] = [];
    const failures = await runDestinationDispatchCycle([
      {
        destinationProvider: 'x',
        reconcile: () => {
          calls.push('x:reconcile');
          return Promise.resolve(0);
        },
        dispatch: () => {
          calls.push('x:dispatch');
          return Promise.resolve(1);
        },
      },
      {
        destinationProvider: 'youtube',
        reconcile: () => {
          calls.push('youtube:reconcile');
          return Promise.resolve(0);
        },
        dispatch: () => {
          calls.push('youtube:dispatch');
          return Promise.resolve(1);
        },
      },
    ]);

    expect(calls).toEqual(['x:reconcile', 'x:dispatch', 'youtube:reconcile', 'youtube:dispatch']);
    expect(failures).toEqual([]);
  });

  it('isolates a failing destination without skipping the next provider', async () => {
    const calls: string[] = [];
    const failures = await runDestinationDispatchCycle([
      {
        destinationProvider: 'x',
        reconcile: () => Promise.reject(new Error('X unavailable')),
        dispatch: () => Promise.reject(new Error('must not dispatch')),
      },
      {
        destinationProvider: 'youtube',
        reconcile: () => {
          calls.push('youtube:reconcile');
          return Promise.resolve(0);
        },
        dispatch: () => {
          calls.push('youtube:dispatch');
          return Promise.resolve(1);
        },
      },
    ]);
    expect(failures).toEqual([{ destinationProvider: 'x', phase: 'reconcile' }]);
    expect(calls).toEqual(['youtube:reconcile', 'youtube:dispatch']);
  });
});
