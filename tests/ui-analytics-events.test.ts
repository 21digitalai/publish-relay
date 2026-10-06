import { afterEach, expect, it, vi } from 'vitest';

import { emitAnalyticsAction } from '../src/ui/analytics-events.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('emits only the typed anonymous action payload to an optional host listener', () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal('window', { dispatchEvent });
  vi.stubGlobal(
    'CustomEvent',
    class {
      type: string;
      detail: unknown;
      constructor(type: string, options: { detail: unknown }) {
        this.type = type;
        this.detail = options.detail;
      }
    },
  );
  emitAnalyticsAction('provider_connect_attempted', { provider: 'x' });
  expect(dispatchEvent).toHaveBeenCalledOnce();
  expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
    type: 'publish-relay-analytics',
    detail: { type: 'provider_connect_attempted', properties: { provider: 'x' } },
  });
});
