import { createHash, randomBytes } from 'node:crypto';

const PREFIX_BYTES = 6;
const SECRET_BYTES = 32;

export const API_KEY_CAPABILITIES = [
  'destinations:read',
  'schedules:read',
  'schedules:write',
  'content:write',
  'publishes:submit',
  'publishes:retry',
  'audit:read',
  'fanvue:chats:read',
  'fanvue:chats:send',
  'fanvue:posts:read',
  'fanvue:media:read',
  'fanvue:audience:read',
  'fanvue:media:upload',
  'fanvue:comments:send',
  'fanvue:payments:read',
  'engagement:propose',
] as const;

export type ApiKeyCapability = (typeof API_KEY_CAPABILITIES)[number];

const API_KEY_CAPABILITY_SET: ReadonlySet<string> = new Set(API_KEY_CAPABILITIES);

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

export function parseApiKeyCapabilities(values: readonly string[]): ApiKeyCapability[] {
  const capabilities = [...new Set(values)];
  if (capabilities.some((capability) => !API_KEY_CAPABILITY_SET.has(capability)))
    throw new Error('API key contains an unsupported capability');
  return capabilities as ApiKeyCapability[];
}

export function hasApiKeyCapability(
  capabilities: ReadonlySet<ApiKeyCapability>,
  required: ApiKeyCapability,
): boolean {
  return capabilities.has(required);
}

export function requireApiKeyCapability(
  capabilities: ReadonlySet<ApiKeyCapability>,
  required: ApiKeyCapability,
): void {
  if (!hasApiKeyCapability(capabilities, required))
    throw new Error(`API key is missing capability ${required}`);
}
