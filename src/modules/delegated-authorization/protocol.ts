import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const DELEGATED_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const DELEGATED_AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;

export interface RegisteredClient {
  id: string;
  redirectUris: readonly string[];
  allowedScopes: readonly string[];
}

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  requestedScopes: readonly string[];
}

export class DelegatedAuthorizationError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'invalid_client' | 'invalid_scope',
    message: string,
  ) {
    super(message);
  }
}

export function validateAuthorizationRequest(
  input: AuthorizationRequest,
  client: RegisteredClient | null,
): { scopes: string[] } {
  if (client?.id !== input.clientId)
    throw new DelegatedAuthorizationError('invalid_client', 'Client is not registered');
  if (!input.state) throw new DelegatedAuthorizationError('invalid_request', 'State is required');
  if (!client.redirectUris.includes(input.redirectUri))
    throw new DelegatedAuthorizationError('invalid_request', 'Redirect URI is not registered');
  if (input.codeChallengeMethod !== 'S256' || !isPkceValue(input.codeChallenge))
    throw new DelegatedAuthorizationError('invalid_request', 'PKCE S256 is required');

  const scopes = [...new Set(input.requestedScopes)];
  if (!scopes.length || scopes.some((scope) => !client.allowedScopes.includes(scope)))
    throw new DelegatedAuthorizationError('invalid_scope', 'Requested scope is not allowed');
  return { scopes };
}

export function createAuthorizationCode(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashSecret(raw) };
}

export function createDelegatedToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashSecret(raw) };
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function verifySecret(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyPkce(codeVerifier: string, expectedChallenge: string): boolean {
  const actual = derivePkceChallenge(codeVerifier);
  if (!actual || !isPkceValue(expectedChallenge)) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expectedChallenge);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function derivePkceChallenge(codeVerifier: string): string | null {
  if (!isPkceValue(codeVerifier)) return null;
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

function isPkceValue(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}
