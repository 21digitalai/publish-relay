import { describe, expect, it } from 'vitest';

import {
  createAuthorizationCode,
  createDelegatedToken,
  hashSecret,
  validateAuthorizationRequest,
  verifyPkce,
  verifySecret,
} from '../src/modules/delegated-authorization/protocol.js';

const verifier = 'test-verifier-abcdefghijklmnopqrstuvwxyz-0123456789';
const challenge = 'QFVFIYowA-CaLwYQKnkBmBcuiBpr_RSxgOKjKtT9nlc';
const redirectUri = 'http://127.0.0.1:43123/integrations/publish-relay/callback';
const client = {
  id: 'open-clips-dev',
  redirectUris: [redirectUri],
  allowedScopes: ['destinations:read', 'media:write', 'publishes:write', 'publishes:read'],
};

describe('delegated authorization protocol', () => {
  it('accepts an exact redirect, mandatory state, S256 PKCE, and allowlisted scopes', () => {
    expect(
      validateAuthorizationRequest(
        {
          clientId: client.id,
          redirectUri,
          state: 'opaque-client-state',
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
          requestedScopes: ['destinations:read', 'destinations:read', 'media:write'],
        },
        client,
      ),
    ).toEqual({ scopes: ['destinations:read', 'media:write'] });
  });

  it.each([
    ['missing state', { state: '' }],
    [
      'redirect mismatch',
      { redirectUri: 'http://localhost:43123/integrations/publish-relay/callback' },
    ],
    ['PKCE downgrade', { codeChallengeMethod: 'plain' }],
    ['missing PKCE', { codeChallenge: '' }],
  ])('rejects %s', (_label, override) => {
    expect(() =>
      validateAuthorizationRequest(
        {
          clientId: client.id,
          redirectUri,
          state: 'state',
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
          requestedScopes: ['destinations:read'],
          ...override,
        },
        client,
      ),
    ).toThrow();
  });

  it('rejects unknown clients and scope escalation', () => {
    const request = {
      clientId: client.id,
      redirectUri,
      state: 'state',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      requestedScopes: ['admin:all'],
    };
    expect(() => validateAuthorizationRequest(request, null)).toThrow(/registered/);
    expect(() => validateAuthorizationRequest(request, client)).toThrow(/scope/);
  });

  it('verifies S256 without accepting malformed or mismatched verifiers', () => {
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce(`${verifier}x`, challenge)).toBe(false);
    expect(verifyPkce('short', challenge)).toBe(false);
  });

  it('creates opaque authorization codes and tokens that are stored only as hashes', () => {
    for (const credential of [createAuthorizationCode(), createDelegatedToken()]) {
      expect(credential.raw).not.toBe(credential.hash);
      expect(credential.hash).toBe(hashSecret(credential.raw));
      expect(verifySecret(credential.raw, credential.hash)).toBe(true);
      expect(verifySecret(`${credential.raw}x`, credential.hash)).toBe(false);
    }
  });
});
