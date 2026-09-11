import { describe, expect, it } from 'vitest';

import {
  createMagicLinkSecretMaterial,
  magicLinkExpiresAt,
  normalizeMagicLinkEmail,
  validateMagicLinkRedirect,
} from '../src/modules/identity/magic-link.js';

describe('magic-link identity primitives', () => {
  it('normalizes email and derives only irreversible persistence material', () => {
    const material = createMagicLinkSecretMaterial({
      email: ' Owner@Example.Test ',
      networkKey: 'network-key',
      userAgent: 'browser',
      pepper: 'test-pepper',
    });
    expect(normalizeMagicLinkEmail(' Owner@Example.Test ')).toBe('owner@example.test');
    expect(material.token).not.toBe(material.tokenHash);
    expect(material.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(material.emailKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(material)).not.toContain('owner@example.test');
  });

  it('uses a fixed fifteen-minute lifetime', () => {
    expect(magicLinkExpiresAt(new Date(0))).toEqual(new Date(15 * 60 * 1_000));
  });

  it.each(['/app', '/app?tab=queue', '/w/relay#calendar'])(
    'accepts relative redirect %s',
    (path) => {
      expect(validateMagicLinkRedirect(path)).toBe(path);
    },
  );

  it.each(['https://evil.example/path', '//evil.example/path', '/\\evil.example/path', 'app'])(
    'rejects unsafe redirect %s',
    (path) => {
      expect(() => validateMagicLinkRedirect(path)).toThrow('same-origin relative path');
    },
  );

  it('defaults a missing redirect to the protected application', () => {
    expect(validateMagicLinkRedirect()).toBe('/app');
  });
});
