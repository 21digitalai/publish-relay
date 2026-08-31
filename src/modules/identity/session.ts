import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'publish_relay_session';
export const CSRF_COOKIE = 'publish_relay_csrf';

export function createOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifyCsrfToken(
  cookieToken: string | undefined,
  headerToken: string | undefined,
): boolean {
  if (!cookieToken || !headerToken) return false;
  const cookie = Buffer.from(cookieToken);
  const header = Buffer.from(headerToken);
  return cookie.length === header.length && timingSafeEqual(cookie, header);
}

export function sessionCookieOptions(isProduction: boolean): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
} {
  return { httpOnly: true, sameSite: 'lax', secure: isProduction, path: '/' };
}
