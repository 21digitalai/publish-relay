import { describe, expect, it } from 'vitest';

import {
  isMessengerPageEligible,
  type MessengerPageEvidence,
} from '../src/modules/providers/facebook-messenger-read.service.js';

const permitted: MessengerPageEvidence = {
  accountId: 'selected-page',
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
    expect(isMessengerPageEligible(permitted)).toBe(true);
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
      expect(isMessengerPageEligible({ ...permitted, ...denied })).toBe(false);
    }
  });
});
