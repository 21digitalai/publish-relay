import { z } from 'zod';

const AUTH_ORIGIN = 'https://accounts.snapchat.com';
const API_ORIGIN = 'https://businessapi.snapchat.com';
const PROFILE_SCOPE = 'snapchat-profile-api';
const REQUEST_TIMEOUT_MS = 15_000;

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  scope: z.string().min(1),
});
const profileSchema = z.object({
  request_status: z.literal('SUCCESS'),
  public_profile: z.object({
    id: z.uuid(),
    display_name: z.string().min(1).max(100),
    snap_user_name: z.string().min(1).optional(),
  }),
});

export type SnapchatToken = z.infer<typeof tokenSchema>;
export type SnapchatOwnerProfile = z.infer<typeof profileSchema>['public_profile'];

export class SnapchatRequestError extends Error {
  public constructor(public readonly status: number) {
    super(`Snapchat request failed (HTTP ${String(status)})`);
  }
}

export class SnapchatHttpClient {
  private readonly request: typeof fetch;

  public constructor(
    private readonly options: {
      clientId: string;
      clientSecret: string;
      fetch?: typeof fetch;
      timeoutMs?: number;
    },
  ) {
    if (!options.clientId || !options.clientSecret)
      throw new Error('Snapchat OAuth client credentials are required');
    this.request = options.fetch ?? fetch;
  }

  public authorizationUrl(input: { redirectUri: string; state: string }): string {
    if (new URL(input.redirectUri).protocol !== 'https:' || !input.state)
      throw new Error('Snapchat OAuth requires an HTTPS redirect and state');
    const url = new URL('/login/oauth2/authorize', AUTH_ORIGIN);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', PROFILE_SCOPE);
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  public exchangeCode(input: { code: string; redirectUri: string }): Promise<SnapchatToken> {
    if (!input.code) throw new Error('Snapchat OAuth code is required');
    return this.token({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
    });
  }

  public refreshToken(refreshToken: string): Promise<SnapchatToken> {
    if (!refreshToken) throw new Error('Snapchat refresh token is required');
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  public async discoverOwnerProfile(accessToken: string): Promise<SnapchatOwnerProfile> {
    if (!accessToken) throw new Error('Snapchat access token is required');
    const response = await this.request(`${API_ORIGIN}/v1/public_profiles/my_profile`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new SnapchatRequestError(response.status);
    const parsed = profileSchema.safeParse(body);
    if (!parsed.success) throw new SnapchatRequestError(response.status);
    return parsed.data.public_profile;
  }

  private async token(fields: Record<string, string>): Promise<SnapchatToken> {
    const response = await this.request(`${AUTH_ORIGIN}/login/oauth2/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...fields,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new SnapchatRequestError(response.status);
    const parsed = tokenSchema.safeParse(body);
    if (!parsed.success || !parsed.data.scope.split(/[\s,]+/).includes(PROFILE_SCOPE))
      throw new SnapchatRequestError(response.status);
    return parsed.data;
  }
}
