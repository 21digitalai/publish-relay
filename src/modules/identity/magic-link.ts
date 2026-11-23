import { createHmac } from 'node:crypto';

import { deriveAuthRateLimitKeys, normalizeAuthRateLimitEmail } from './auth-rate-limit.js';
import { createOpaqueToken, hashOpaqueToken } from './session.js';

export const MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1_000;
export const DEFAULT_MAGIC_LINK_REDIRECT = '/app';

export interface MagicLinkSecretMaterial {
  token: string;
  tokenHash: string;
  emailKeyHash: string;
  networkKeyHash: string;
  userAgentHash: string;
}

function hmac(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(value, 'utf8').digest('hex');
}

export function hashMagicLinkBinding(value: string, pepper: string): string {
  if (!pepper) throw new Error('Magic-link challenge pepper is required');
  return hmac(value, pepper);
}

export function normalizeMagicLinkEmail(email: string): string {
  return normalizeAuthRateLimitEmail(email);
}

export function validateMagicLinkRedirect(redirectPath?: string): string {
  if (!redirectPath) return DEFAULT_MAGIC_LINK_REDIRECT;
  if (
    !redirectPath.startsWith('/') ||
    redirectPath.startsWith('//') ||
    redirectPath.includes('\\')
  ) {
    throw new Error('Magic-link redirect must be a same-origin relative path');
  }
  const parsed = new URL(redirectPath, 'https://publish-relay.invalid');
  if (parsed.origin !== 'https://publish-relay.invalid') {
    throw new Error('Magic-link redirect must be a same-origin relative path');
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function createMagicLinkSecretMaterial(input: {
  email: string;
  networkKey: string;
  userAgent: string;
  pepper: string;
}): MagicLinkSecretMaterial {
  if (!input.pepper) throw new Error('Magic-link challenge pepper is required');
  const token = createOpaqueToken();
  const rateLimitKeys = deriveAuthRateLimitKeys({
    email: input.email,
    networkKey: input.networkKey,
    secret: input.pepper,
  });
  return {
    token,
    tokenHash: hashOpaqueToken(token),
    ...rateLimitKeys,
    userAgentHash: hashMagicLinkBinding(input.userAgent, input.pepper),
  };
}

export function magicLinkExpiresAt(now: Date): Date {
  return new Date(now.getTime() + MAGIC_LINK_LIFETIME_MS);
}
