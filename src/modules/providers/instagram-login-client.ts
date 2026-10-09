import { z } from 'zod';

export const INSTAGRAM_LOGIN_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
] as const;

const shortTokenSchema = z.object({
  access_token: z.string().min(1),
  user_id: z.union([z.string().min(1), z.number().int().transform(String)]),
  permissions: z.array(z.string()),
});
const longTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive(),
});
const accountSchema = z.object({
  id: z.string().min(1),
  user_id: z.string().min(1),
  username: z.string().min(1),
  account_type: z.enum(['BUSINESS', 'MEDIA_CREATOR', 'CREATOR']),
});

export class InstagramLoginRequestError extends Error {
  public constructor(public readonly status: number) {
    super(`Instagram Login request failed (HTTP ${String(status)})`);
  }
}

export class InstagramLoginPermissionError extends Error {
  public constructor() {
    super('Instagram did not grant both required permissions');
  }
}

export class InstagramLoginAccountError extends Error {
  public constructor() {
    super('No eligible Instagram professional account was found');
  }
}

export interface InstagramLoginGrant {
  accessToken: string;
  appScopedUserId: string;
  remoteUserId: string;
  username: string;
  expiresAt: Date;
}

export class InstagramLoginClient {
  private readonly request: typeof fetch;
  private readonly now: () => number;

  public constructor(
    private readonly options: {
      appId: string;
      appSecret: string;
      graphVersion: string;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {
    if (!options.appId || !options.appSecret || !/^v\d+\.\d+$/.test(options.graphVersion))
      throw new Error('Instagram Login requires its own app credentials and pinned Graph version');
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  public authorizationUrl(input: { redirectUri: string; state: string }): string {
    const url = new URL('https://www.instagram.com/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: this.options.appId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: INSTAGRAM_LOGIN_SCOPES.join(','),
      state: input.state,
    }).toString();
    return url.toString();
  }

  public async exchangeCode(input: {
    code: string;
    redirectUri: string;
  }): Promise<InstagramLoginGrant> {
    const short = shortTokenSchema.parse(
      await this.fetchJson('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.options.appId,
          client_secret: this.options.appSecret,
          grant_type: 'authorization_code',
          redirect_uri: input.redirectUri,
          code: input.code,
        }),
      }),
    );
    if (INSTAGRAM_LOGIN_SCOPES.some((scope) => !short.permissions.includes(scope)))
      throw new InstagramLoginPermissionError();
    const longUrl = new URL('https://graph.instagram.com/access_token');
    longUrl.search = new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: this.options.appSecret,
      access_token: short.access_token,
    }).toString();
    const long = longTokenSchema.parse(await this.fetchJson(longUrl));
    const accountUrl = new URL(`https://graph.instagram.com/${this.options.graphVersion}/me`);
    accountUrl.searchParams.set('fields', 'id,user_id,username,account_type');
    const accountResult = accountSchema.safeParse(
      await this.fetchJson(accountUrl, {
        headers: { authorization: `Bearer ${long.access_token}` },
      }),
    );
    if (!accountResult.success) throw new InstagramLoginAccountError();
    const account = accountResult.data;
    if (account.id !== short.user_id || !account.user_id) throw new InstagramLoginAccountError();
    return {
      accessToken: long.access_token,
      appScopedUserId: short.user_id,
      remoteUserId: account.user_id,
      username: account.username,
      expiresAt: new Date(this.now() + long.expires_in * 1000),
    };
  }

  public async refreshToken(
    accessToken: string,
  ): Promise<{ accessToken: string; expiresAt: Date }> {
    const url = new URL('https://graph.instagram.com/refresh_access_token');
    url.search = new URLSearchParams({
      grant_type: 'ig_refresh_token',
      access_token: accessToken,
    }).toString();
    const refreshed = longTokenSchema.parse(await this.fetchJson(url));
    return {
      accessToken: refreshed.access_token,
      expiresAt: new Date(this.now() + refreshed.expires_in * 1000),
    };
  }

  private async fetchJson(url: string | URL, init?: RequestInit): Promise<unknown> {
    const response = await this.request(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: new Headers({
        accept: 'application/json',
        ...Object.fromEntries(new Headers(init?.headers)),
      }),
    });
    if (!response.ok) throw new InstagramLoginRequestError(response.status);
    return response.json() as Promise<unknown>;
  }
}
