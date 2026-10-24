import { z } from 'zod';

export const FANVUE_PUBLISHING_SCOPES = [
  'openid',
  'offline_access',
  'offline',
  'read:self',
  'write:media',
  'write:post',
] as const;

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  scope: z.string().min(1),
});
const profileSchema = z.object({
  uuid: z.uuid(),
  displayName: z.string().min(1).optional(),
  handle: z.string().min(1).optional(),
  isCreator: z.boolean(),
});

export type FanvueToken = z.infer<typeof tokenSchema>;
export type FanvueProfile = z.infer<typeof profileSchema>;

export class FanvueRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null = null,
  ) {
    super(`Fanvue request failed (HTTP ${String(status)})`);
  }
}

export function assertFanvuePublishingScopes(scope: string): string[] {
  const granted = scope.split(/\s+/).filter(Boolean);
  if (
    new Set(granted).size !== FANVUE_PUBLISHING_SCOPES.length ||
    FANVUE_PUBLISHING_SCOPES.some((required) => !granted.includes(required))
  )
    throw new Error('Fanvue publishing grant does not match the requested scopes');
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

  authorizationUrl(input: { redirectUri: string; state: string; codeChallenge: string }): string {
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
    url.searchParams.set('scope', FANVUE_PUBLISHING_SCOPES.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<FanvueToken> {
    if (!input.code || !input.codeVerifier)
      throw new Error('Fanvue OAuth code and verifier are required');
    return this.token({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
  }

  refresh(refreshToken: string): Promise<FanvueToken> {
    if (!refreshToken) throw new Error('Fanvue refresh token is required');
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async discoverCreator(accessToken: string): Promise<FanvueProfile> {
    const response = await this.request('https://api.fanvue.com/v1/users/me', {
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

  private async token(fields: Record<string, string>): Promise<FanvueToken> {
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
    const token = tokenSchema.safeParse(body);
    if (!token.success) throw new FanvueRequestError(response.status);
    assertFanvuePublishingScopes(token.data.scope);
    return token.data;
  }
}
