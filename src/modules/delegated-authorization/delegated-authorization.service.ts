import {
  createAuthorizationCode,
  createDelegatedToken,
  DELEGATED_ACCESS_TOKEN_TTL_SECONDS,
  derivePkceChallenge,
  hashSecret,
  type AuthorizationRequest,
  type RegisteredClient,
  validateAuthorizationRequest,
} from './protocol.js';

const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface DelegatedPrincipal {
  grantId: string;
  workspaceId: string;
  userId: string;
  clientId: string;
  scopes: string[];
}

export interface DelegatedGrantSummary {
  id: string;
  clientId: string;
  scopes: string[];
  createdAt: Date;
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
  createGrantAndCode(
    input: AuthorizationCodeRecord & {
      codeHash: string;
      expiresAt: Date;
      requestId: string;
    },
  ): Promise<void>;
  exchangeCode(input: {
    codeHash: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    now: Date;
    replacement: TokenPairPersistence;
  }): Promise<DelegatedPrincipal | null>;
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
  listGrants(workspaceId: string, userId: string): Promise<DelegatedGrantSummary[]>;
  revokeGrant(
    workspaceId: string,
    userId: string,
    grantId: string,
    now: Date,
    requestId: string,
  ): Promise<boolean>;
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

  async approve(
    input: AuthorizationRequest & DelegatedPrincipal & { requestId: string },
  ): Promise<{ code: string }> {
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
    const codeChallenge = derivePkceChallenge(input.codeVerifier);
    if (!codeChallenge) throw new DelegatedTokenError('Authorization code is invalid or expired');
    const pair = createTokenPair(now);
    const authorization = await this.store.exchangeCode({
      codeHash: hashSecret(input.code),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge,
      now,
      replacement: pair.persisted,
    });
    if (!authorization) throw new DelegatedTokenError('Authorization code is invalid or expired');
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

  list(workspaceId: string, userId: string): Promise<DelegatedGrantSummary[]> {
    return this.store.listGrants(workspaceId, userId);
  }

  revoke(
    workspaceId: string,
    userId: string,
    grantId: string,
    requestId: string,
  ): Promise<boolean> {
    return this.store.revokeGrant(workspaceId, userId, grantId, this.now(), requestId);
  }
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

interface TokenPairPersistence {
  accessTokenHash: string;
  accessExpiresAt: Date;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
}

function createTokenPair(now: Date): { public: TokenPair; persisted: TokenPairPersistence } {
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
