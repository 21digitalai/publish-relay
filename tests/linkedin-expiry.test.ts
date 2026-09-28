import { describe, expect, it } from 'vitest';

import { linkedInExpiryWarning } from '../src/ui/linkedin-expiry.js';

describe('LinkedIn on-visit expiry warnings', () => {
  const now = Date.parse('2026-09-28T07:00:00Z');
  const account = { id: 'member-1', displayName: 'Member One', status: 'active' };
  const at = (days: number) => new Date(now + days * 86_400_000).toISOString();

  it('shows the 7, 3, and 1-day bands with an exact expiry date', () => {
    expect(linkedInExpiryWarning({ ...account, expiresAt: at(8) }, now)).toBeNull();
    for (const [days, label] of [
      [7, 'within 7 days'],
      [3, 'within 3 days'],
      [1, 'within 1 day'],
    ] as const) {
      const message = linkedInExpiryWarning({ ...account, expiresAt: at(days) }, now);
      expect(message).toContain(label);
      expect(message).toContain('Member One');
      expect(message).toContain(
        new Date(at(days)).toLocaleDateString(undefined, { dateStyle: 'medium' }),
      );
    }
  });

  it('states expired access without implying a proactive notification', () => {
    expect(linkedInExpiryWarning({ ...account, expiresAt: at(-1) }, now)).toContain(
      'has expired or needs reconnection',
    );
    expect(linkedInExpiryWarning(account, now)).toBeNull();
  });
});
