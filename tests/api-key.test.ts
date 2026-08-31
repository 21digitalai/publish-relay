import { describe, expect, it } from 'vitest';

import {
  createApiKeyMaterial,
  hashApiKeySecret,
  isApiKeyUsable,
  parseApiKeyToken,
} from '../src/modules/identity/api-key.js';

describe('API key material', () => {
  it('reveals the secret once while keeping a stable public prefix and hash', () => {
    const material = createApiKeyMaterial();
    const parsed = parseApiKeyToken(material.token);
    expect(material.prefix).toMatch(/^pr_[0-9a-f]{12}$/);
    expect(parsed).toEqual({ prefix: material.prefix, secret: material.secret });
    expect(hashApiKeySecret(material.secret)).toBe(material.secretHash);
    expect(material.secretHash).not.toContain(material.secret);
  });

  it('rejects malformed tokens', () => {
    expect(parseApiKeyToken('')).toBeNull();
    expect(parseApiKeyToken('prefix-only')).toBeNull();
    expect(parseApiKeyToken('.secret')).toBeNull();
  });

  it('enforces revocation and expiry', () => {
    const now = new Date('2026-08-31T12:00:00Z');
    expect(isApiKeyUsable({ expiresAt: null, revokedAt: null }, now)).toBe(true);
    expect(
      isApiKeyUsable({ expiresAt: new Date('2026-08-31T12:00:01Z'), revokedAt: null }, now),
    ).toBe(true);
    expect(isApiKeyUsable({ expiresAt: now, revokedAt: null }, now)).toBe(false);
    expect(isApiKeyUsable({ expiresAt: null, revokedAt: now }, now)).toBe(false);
  });
});
