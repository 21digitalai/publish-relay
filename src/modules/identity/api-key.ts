import { createHash, randomBytes } from 'node:crypto';

const PREFIX_BYTES = 6;
const SECRET_BYTES = 32;

export interface ApiKeyMaterial {
  prefix: string;
  secret: string;
  token: string;
  secretHash: string;
}

export function hashApiKeySecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function createApiKeyMaterial(): ApiKeyMaterial {
  const prefix = `pr_${randomBytes(PREFIX_BYTES).toString('hex')}`;
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return { prefix, secret, token: `${prefix}.${secret}`, secretHash: hashApiKeySecret(secret) };
}

export function parseApiKeyToken(token: string): { prefix: string; secret: string } | null {
  const separator = token.indexOf('.');
  if (separator <= 0 || separator === token.length - 1) return null;
  return { prefix: token.slice(0, separator), secret: token.slice(separator + 1) };
}

export function isApiKeyUsable(
  input: { expiresAt: Date | null; revokedAt: Date | null },
  now = new Date(),
): boolean {
  return input.revokedAt === null && (input.expiresAt === null || input.expiresAt > now);
}
