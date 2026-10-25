import { z } from 'zod';

export const FANVUE_PUBLISHING_SCOPES = [
  'openid',
  'offline_access',
  'offline',
  'read:self',
  'read:media',
  'write:media',
  'read:post',
  'write:post',
] as const;
export const FANVUE_CHAT_READ_SCOPES = [...FANVUE_PUBLISHING_SCOPES, 'read:chat'] as const;
export const FANVUE_CHAT_SEND_SCOPES = [...FANVUE_CHAT_READ_SCOPES, 'write:chat'] as const;
export const FANVUE_PAYMENT_SCOPE = 'read:creator';
export const FANVUE_AUDIENCE_SCOPE = 'read:fan';

export const fanvueTokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive(),
  scope: z.string().min(1),
});
const profileSchema = z.object({
  uuid: z.uuid(),
  displayName: z.string().min(1).optional(),
  handle: z.string().min(1).optional(),
  isCreator: z.boolean(),
});

export type FanvueToken = z.infer<typeof fanvueTokenSchema>;
export type FanvueProfile = z.infer<typeof profileSchema>;

export class FanvueRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null = null,
  ) {
    super(`Fanvue request failed (HTTP ${String(status)})`);
  }
}

export class FanvueScopeError extends Error {
  constructor(
    public readonly grant: 'publishing' | 'chat_read' | 'chat_send' | 'payment' | 'audience',
  ) {
    super(`Fanvue ${grant.replace('_', '-')} grant does not match the requested scopes`);
  }
}

export function assertFanvuePublishingScopes(scope: string): string[] {
  const granted = scope.split(/\s+/).filter(Boolean);
  if (
    new Set(granted).size !== FANVUE_PUBLISHING_SCOPES.length ||
    FANVUE_PUBLISHING_SCOPES.some((required) => !granted.includes(required))
  )
    throw new FanvueScopeError('publishing');
  return granted;
}

export function assertFanvueChatReadScopes(scope: string): string[] {
  const granted = scope.split(/\s+/).filter(Boolean);
  if (
    new Set(granted).size !== FANVUE_CHAT_READ_SCOPES.length ||
    FANVUE_CHAT_READ_SCOPES.some((required) => !granted.includes(required))
  )
    throw new FanvueScopeError('chat_read');
  return granted;
}

export function assertFanvueChatSendScopes(scope: string): string[] {
  const granted = scope.split(/\s+/).filter(Boolean);
  if (
    new Set(granted).size !== FANVUE_CHAT_SEND_SCOPES.length ||
    FANVUE_CHAT_SEND_SCOPES.some((required) => !granted.includes(required))
  )
    throw new FanvueScopeError('chat_send');
  return granted;
}

export function assertFanvueReadGrantScopes(scope: string): string[] {
  const granted = scope.split(/\s+/).filter(Boolean);
  const allowed = new Set<string>([
    ...FANVUE_PUBLISHING_SCOPES,
    'read:chat',
    'write:chat',
    'read:post',
    'read:media',
    FANVUE_PAYMENT_SCOPE,
    FANVUE_AUDIENCE_SCOPE,
  ]);
  if (
    new Set(granted).size !== granted.length ||
    granted.some((value) => !allowed.has(value)) ||
    FANVUE_PUBLISHING_SCOPES.some((required) => !granted.includes(required))
  )
    throw new Error('Fanvue grant is missing publishing authority or has unsupported scopes');
  return granted;
}

export class FanvueHttpClient {
  private readonly request: typeof fetch;

  constructor(
    private readonly options: {
      clientId: string;
      clientSecret: string;
      fetch?: typeof fetch;
      timeoutMs?: number;
    },
  ) {
    if (!options.clientId || !options.clientSecret)
      throw new Error('Fanvue confidential client credentials are required');
    this.request = options.fetch ?? fetch;
  }

  authorizationUrl(input: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    readChat?: boolean;
    sendChat?: boolean;
    payment?: boolean;
    audience?: boolean;
    existingScopes?: readonly string[];
  }): string {
    if (
      new URL(input.redirectUri).protocol !== 'https:' ||
      input.state.length < 32 ||
      !input.codeChallenge
    )
      throw new Error('Fanvue OAuth requires HTTPS, state and PKCE');
    const url = new URL('https://auth.fanvue.com/oauth2/auth');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    const required = input.audience
      ? [...FANVUE_PUBLISHING_SCOPES, FANVUE_AUDIENCE_SCOPE]
      : input.sendChat
        ? FANVUE_CHAT_SEND_SCOPES
        : input.readChat
          ? FANVUE_CHAT_READ_SCOPES
          : input.payment
            ? [...FANVUE_PUBLISHING_SCOPES, FANVUE_PAYMENT_SCOPE]
            : FANVUE_PUBLISHING_SCOPES;
    const scopes = input.existingScopes
      ? [...new Set([...required, ...input.existingScopes])]
      : [...required];
    if (
      input.existingScopes &&
      scopes.some(
        (scope) =>
          !new Set<string>([
            ...FANVUE_CHAT_SEND_SCOPES,
            FANVUE_PAYMENT_SCOPE,
            FANVUE_AUDIENCE_SCOPE,
          ]).has(scope),
      )
    )
      throw new Error('Unsupported existing Fanvue scope');
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    readChat?: boolean;
    sendChat?: boolean;
    payment?: boolean;
    audience?: boolean;
    requiredScopes?: readonly string[];
  }): Promise<FanvueToken> {
    if (!input.code || !input.codeVerifier)
      throw new Error('Fanvue OAuth code and verifier are required');
    return this.token(
      {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      },
      input.audience
        ? 'audience'
        : input.payment
          ? 'payment'
          : input.sendChat
            ? 'chat_send'
            : input.readChat
              ? 'chat_read'
              : 'publishing',
      input.requiredScopes,
    );
  }

  refresh(refreshToken: string): Promise<FanvueToken> {
    if (!refreshToken) throw new Error('Fanvue refresh token is required');
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'refresh');
  }

  async discoverCreator(accessToken: string): Promise<FanvueProfile> {
    const response = await this.request('https://api.fanvue.com/users/me', {
      headers: { Authorization: `Bearer ${accessToken}`, 'X-Fanvue-API-Version': '2025-06-26' },
      redirect: 'error',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
    if (!response.ok) throw new FanvueRequestError(response.status);
    const parsed = profileSchema.safeParse(await response.json());
    if (!parsed.success || !parsed.data.isCreator)
      throw new Error('Fanvue publishing requires a creator account');
    return parsed.data;
  }

  private async token(
    fields: Record<string, string>,
    scopeMode: 'publishing' | 'chat_read' | 'chat_send' | 'payment' | 'audience' | 'refresh',
    requiredScopes?: readonly string[],
  ): Promise<FanvueToken> {
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString(
      'base64',
    );
    const response = await this.request('https://auth.fanvue.com/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields),
      redirect: 'error',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const error = z.object({ error: z.string().optional() }).safeParse(body);
      throw new FanvueRequestError(
        response.status,
        error.success ? (error.data.error ?? null) : null,
      );
    }
    const token = fanvueTokenSchema.safeParse(body);
    if (!token.success) throw new FanvueRequestError(response.status);
    if (scopeMode === 'publishing') assertFanvuePublishingScopes(token.data.scope);
    else if (requiredScopes) {
      const granted = assertFanvueReadGrantScopes(token.data.scope);
      if (requiredScopes.some((scope) => !granted.includes(scope)))
        throw new FanvueScopeError(scopeMode === 'refresh' ? 'payment' : scopeMode);
    } else if (scopeMode === 'chat_read') assertFanvueChatReadScopes(token.data.scope);
    else if (scopeMode === 'chat_send') assertFanvueChatSendScopes(token.data.scope);
    else {
      const granted = assertFanvueReadGrantScopes(token.data.scope);
      if (scopeMode === 'payment' && !granted.includes(FANVUE_PAYMENT_SCOPE))
        throw new FanvueScopeError('payment');
      if (scopeMode === 'audience' && !granted.includes(FANVUE_AUDIENCE_SCOPE))
        throw new FanvueScopeError('audience');
    }
    return token.data;
  }
}
