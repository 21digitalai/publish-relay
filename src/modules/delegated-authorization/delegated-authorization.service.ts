import {
  createAuthorizationCode,
  createDelegatedToken,
  DELEGATED_ACCESS_TOKEN_TTL_SECONDS,
  hashSecret,
  type AuthorizationRequest,
  type RegisteredClient,
  validateAuthorizationRequest,
  verifyPkce,
} from './protocol.js';

const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface DelegatedPrincipal {
  grantId: string;
  workspaceId: string;
  userId: string;
  clientId: string;
  scopes: string[];
}

interface AuthorizationCodeRecord extends DelegatedPrincipal {
  redirectUri: string;
  codeChallenge: string;
}

interface RefreshTokenRecord extends DelegatedPrincipal {
  tokenId: string;
}

export interface DelegatedAuthorizationStore {
  findClient(clientId: string): Promise<RegisteredClient | null>;
  createGrantAndCode(input: AuthorizationCodeRecord & {
    codeHash: string;
    expiresAt: Date;
  }): Promise<void>;
  consumeCode(input: {
    codeHash: string;
    clientId: string;
    redirectUri: string;
    now: Date;
  }): Promise<AuthorizationCodeRecord | null>;
  createTokenPair(input: DelegatedPrincipal & {
    accessTokenHash: string;
    accessExpiresAt: Date;
    refreshTokenHash: string;
    refreshExpiresAt: Date;
    rotatedFromTokenId?: string;
  }): Promise<void>;
  rotateRefreshToken(input: {
    refreshTokenHash: string;
    now: Date;
    replacement: {
      accessTokenHash: string;
      accessExpiresAt: Date;
      refreshTokenHash: string;
      refreshExpiresAt: Date;
    };
  }): Promise<RefreshTokenRecord | null>;
  authenticateAccessToken(accessTokenHash: string, now: Date): Promise<DelegatedPrincipal | null>;
  revokeGrant(workspaceId: string, userId: string, grantId: string, now: Date): Promise<boolean>;
}

export class DelegatedTokenError extends Error {
  readonly code = 'invalid_grant';
}

export class DelegatedAuthorizationService {
  constructor(
    private readonly store: DelegatedAuthorizationStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async inspectAuthorization(input: AuthorizationRequest): Promise<RegisteredClient> {
    const client = await this.store.findClient(input.clientId);
    validateAuthorizationRequest(input, client);
    if (!client) throw new Error('Validated delegated client unexpectedly missing');
    return client;
  }

  async approve(input: AuthorizationRequest & DelegatedPrincipal): Promise<{ code: string }> {
    const client = await this.inspectAuthorization(input);
    const { scopes } = validateAuthorizationRequest(input, client);
    const code = createAuthorizationCode();
    const now = this.now();
    await this.store.createGrantAndCode({
      ...input,
      scopes,
      codeHash: code.hash,
      expiresAt: addSeconds(now, 5 * 60),
    });
    return { code: code.raw };
  }

  async exchangeCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<TokenPair> {
    const now = this.now();
    const authorization = await this.store.consumeCode({
      codeHash: hashSecret(input.code),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      now,
    });
    if (!authorization || !verifyPkce(input.codeVerifier, authorization.codeChallenge))
      throw new DelegatedTokenError('Authorization code is invalid or expired');
    const pair = createTokenPair(now);
    await this.store.createTokenPair({ ...authorization, ...pair.persisted });
    return pair.public;
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const now = this.now();
    const pair = createTokenPair(now);
    const current = await this.store.rotateRefreshToken({
      refreshTokenHash: hashSecret(refreshToken),
      now,
      replacement: pair.persisted,
    });
    if (!current) throw new DelegatedTokenError('Refresh token is invalid or expired');
    return pair.public;
  }

  authenticate(accessToken: string): Promise<DelegatedPrincipal | null> {
    return this.store.authenticateAccessToken(hashSecret(accessToken), this.now());
  }

  revoke(workspaceId: string, userId: string, grantId: string): Promise<boolean> {
    return this.store.revokeGrant(workspaceId, userId, grantId, this.now());
  }
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

function createTokenPair(now: Date): { public: TokenPair; persisted: {
  accessTokenHash: string;
  accessExpiresAt: Date;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
} } {
  const access = createDelegatedToken();
  const refresh = createDelegatedToken();
  return {
    public: {
      accessToken: access.raw,
      refreshToken: refresh.raw,
      tokenType: 'Bearer',
      expiresIn: DELEGATED_ACCESS_TOKEN_TTL_SECONDS,
    },
    persisted: {
      accessTokenHash: access.hash,
      accessExpiresAt: addSeconds(now, DELEGATED_ACCESS_TOKEN_TTL_SECONDS),
      refreshTokenHash: refresh.hash,
      refreshExpiresAt: addSeconds(now, REFRESH_TOKEN_TTL_SECONDS),
    },
  };
}

function addSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1_000);
}
