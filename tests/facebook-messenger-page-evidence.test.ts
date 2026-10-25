import { describe, expect, it } from 'vitest';

import {
  isPageReadEligible,
  type PageReadEvidence,
} from '../src/modules/providers/facebook-page-read-context.service.js';

const permitted: PageReadEvidence = {
  pageId: '12345',
  credentialId: 'page-credential',
  availability: 'active',
  localEnabled: true,
  providerGrant: 'verified',
  connectionStatus: 'active',
  connectionRevokedAt: null,
  scopes: ['pages_messaging', 'pages_manage_metadata', 'pages_read_engagement'],
  capabilitySnapshot: { tasks: ['MESSAGING', 'CREATE_CONTENT'] },
};

describe('Facebook Page Messenger read eligibility', () => {
  it('requires a selected Page token, an active optional module and the exact Meta grant', () => {
    expect(isPageReadEligible(permitted, 'dms')).toBe(true);
    for (const denied of [
      { credentialId: null },
      { localEnabled: false },
      { providerGrant: 'unknown' },
      { providerGrant: 'missing' },
      { availability: 'reauth_required' },
      { connectionStatus: 'revoked' },
      { connectionRevokedAt: new Date() },
      { scopes: ['pages_messaging', 'pages_read_engagement'] },
      { capabilitySnapshot: { tasks: ['CREATE_CONTENT'] } },
      { capabilitySnapshot: {} },
    ]) {
      expect(isPageReadEligible({ ...permitted, ...denied }, 'dms')).toBe(false);
    }
  });

  it('requires the Comments read scope and selected Page task', () => {
    expect(isPageReadEligible(permitted, 'comments')).toBe(true);
    expect(
      isPageReadEligible(
        { ...permitted, scopes: ['pages_messaging', 'pages_manage_metadata'] },
        'comments',
      ),
    ).toBe(false);
    expect(
      isPageReadEligible(
        { ...permitted, capabilitySnapshot: { tasks: ['MESSAGING'] } },
        'comments',
      ),
    ).toBe(false);
  });
});
