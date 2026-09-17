import { describe, expect, it } from 'vitest';

import {
  canPerformWorkspaceAction,
  requireWorkspaceAction,
} from '../src/modules/identity/authorization.js';
import { hashPassword, verifyPassword } from '../src/modules/identity/password.js';
import {
  createOpaqueToken,
  hashOpaqueToken,
  sessionCookieOptions,
  verifyCsrfToken,
} from '../src/modules/identity/session.js';

describe('identity security primitives', () => {
  it('hashes passwords with Argon2id and rejects the wrong password', async () => {
    const passwordHash = await hashPassword('correct horse battery staple');
    expect(passwordHash).toContain('$argon2id$');
    expect(await verifyPassword(passwordHash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(passwordHash, 'wrong password')).toBe(false);
  });

  it('creates opaque session material and stores only its hash', () => {
    const first = createOpaqueToken();
    const second = createOpaqueToken();
    expect(first).not.toBe(second);
    expect(hashOpaqueToken(first)).toHaveLength(64);
    expect(hashOpaqueToken(first)).not.toContain(first);
  });

  it('requires an exact double-submit CSRF token', () => {
    const token = createOpaqueToken();
    expect(verifyCsrfToken(token, token)).toBe(true);
    expect(verifyCsrfToken(token, `${token}x`)).toBe(false);
    expect(verifyCsrfToken(token, undefined)).toBe(false);
  });

  it('uses hardened browser cookie defaults', () => {
    expect(sessionCookieOptions(true)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
    });
  });

  it('centralizes role authorization and observes role changes immediately', () => {
    expect(canPerformWorkspaceAction('editor', 'content:write')).toBe(true);
    expect(canPerformWorkspaceAction('viewer', 'content:write')).toBe(false);
    expect(() => {
      requireWorkspaceAction('viewer', 'workspace:manage');
    }).toThrow(/cannot perform/);
  });
});
