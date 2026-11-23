import { createHmac } from 'node:crypto';

export interface AuthRateLimitKeys {
  emailKeyHash: string;
  networkKeyHash: string;
}

export type AuthRateLimitSecret = string | Buffer;

function hmac(value: string, secret: AuthRateLimitSecret): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

export function normalizeAuthRateLimitEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function deriveAuthRateLimitKeys(input: {
  email: string;
  networkKey: string;
  secret: AuthRateLimitSecret;
}): AuthRateLimitKeys {
  if (input.secret.length === 0) throw new Error('Auth rate-limit secret is required');
  return {
    emailKeyHash: hmac(normalizeAuthRateLimitEmail(input.email), input.secret),
    networkKeyHash: hmac(input.networkKey, input.secret),
  };
}
