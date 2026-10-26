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
  scopes: ['pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'pages_read_engagement'],
  dmsCredentialId: 'page-credential',
  dmsGrantedScopes: [
    'pages_show_list',
    'pages_messaging',
    'pages_manage_metadata',
    'pages_read_engagement',
  ],
  capabilitySnapshot: { tasks: ['MESSAGING', 'CREATE_CONTENT'] },
};

describe('Facebook Page Messenger read eligibility', () => {
  it('requires a selected Page token, an active optional module and the exact Meta grant', () => {
    expect(isPageReadEligible(permitted, 'dms')).toBe(true);
    for (const denied of [
      { credentialId: null },
      { dmsCredentialId: 'previous-page-credential' },
      { dmsCredentialId: null },
      { localEnabled: false },
      { providerGrant: 'unknown' },
      { providerGrant: 'missing' },
      { availability: 'reauth_required' },
      { connectionStatus: 'revoked' },
      { connectionRevokedAt: new Date() },
      { dmsGrantedScopes: ['pages_messaging', 'pages_read_engagement'] },
      { dmsGrantedScopes: ['pages_messaging', 'pages_manage_metadata', 'pages_read_engagement'] },
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
      isPageReadEligible({ ...permitted, scopes: ['pages_read_engagement'] }, 'comments'),
    ).toBe(false);
    expect(isPageReadEligible(permitted, 'comments', ['pages_read_user_content'])).toBe(false);
    expect(
      isPageReadEligible(
        { ...permitted, scopes: [...(permitted.scopes as string[]), 'pages_read_user_content'] },
        'comments',
        ['pages_read_user_content'],
      ),
    ).toBe(true);
    expect(
      isPageReadEligible(
        { ...permitted, capabilitySnapshot: { tasks: ['MESSAGING'] } },
        'comments',
      ),
    ).toBe(false);
  });
});
