import { z } from 'zod';

export const INSTAGRAM_LOGIN_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
] as const;

const instagramIdSchema = z.union([
  z.string().min(1),
  z.number().int().nonnegative().refine(Number.isSafeInteger).transform(String),
]);
const shortTokenSchema = z.object({
  access_token: z.string().min(1),
  user_id: instagramIdSchema,
  permissions: z.union([
    z.array(z.string()),
    z.string().transform((permissions) => permissions.split(',').map((scope) => scope.trim())),
  ]),
});
const longTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive(),
});
const accountSchema = z.object({
  id: instagramIdSchema,
  user_id: instagramIdSchema,
  username: z.string().min(1),
  account_type: z.enum(['BUSINESS', 'MEDIA_CREATOR', 'CREATOR']),
});

export type InstagramLoginStage = 'token-exchange' | 'token-extension' | 'profile-lookup';
export type InstagramLoginFailureCategory =
  'http' | 'transport' | 'invalid-response' | 'permission' | 'ineligible-account';

export class InstagramLoginDiagnosticError extends Error {
  public constructor(
    public readonly stage: InstagramLoginStage,
    public readonly category: InstagramLoginFailureCategory,
    public readonly status?: number,
  ) {
    super(`Instagram Login ${stage} failed (${category})`);
  }
}

export class InstagramLoginRequestError extends InstagramLoginDiagnosticError {
  public constructor(stage: InstagramLoginStage, status: number) {
    super(stage, 'http', status);
  }
}

export class InstagramLoginPermissionError extends InstagramLoginDiagnosticError {
  public constructor() {
    super('token-exchange', 'permission');
  }
}

export class InstagramLoginAccountError extends InstagramLoginDiagnosticError {
  public constructor() {
    super('profile-lookup', 'ineligible-account');
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
    const short = this.parseResponse(
      shortTokenSchema,
      await this.fetchJson('token-exchange', 'https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        body: this.tokenExchangeBody({
          client_id: this.options.appId,
          client_secret: this.options.appSecret,
          grant_type: 'authorization_code',
          redirect_uri: input.redirectUri,
          code: input.code,
        }),
      }),
      'token-exchange',
    );
    if (INSTAGRAM_LOGIN_SCOPES.some((scope) => !short.permissions.includes(scope)))
      throw new InstagramLoginPermissionError();
    const longUrl = new URL('https://graph.instagram.com/access_token');
    longUrl.search = new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: this.options.appSecret,
      access_token: short.access_token,
    }).toString();
    const long = this.parseResponse(
      longTokenSchema,
      await this.fetchJson('token-extension', longUrl),
      'token-extension',
    );
    const accountUrl = new URL(`https://graph.instagram.com/${this.options.graphVersion}/me`);
    accountUrl.searchParams.set('fields', 'id,user_id,username,account_type');
    const accountResult = accountSchema.safeParse(
      await this.fetchJson('profile-lookup', accountUrl, {
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
    const refreshed = this.parseResponse(
      longTokenSchema,
      await this.fetchJson('token-extension', url),
      'token-extension',
    );
    return {
      accessToken: refreshed.access_token,
      expiresAt: new Date(this.now() + refreshed.expires_in * 1000),
    };
  }

  private tokenExchangeBody(fields: Record<string, string>): FormData {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    return body;
  }

  private parseResponse<T>(schema: z.ZodType<T>, value: unknown, stage: InstagramLoginStage): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new InstagramLoginDiagnosticError(stage, 'invalid-response');
    return result.data;
  }

  private async fetchJson(
    stage: InstagramLoginStage,
    url: string | URL,
    init?: RequestInit,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: new Headers({
          accept: 'application/json',
          ...Object.fromEntries(new Headers(init?.headers)),
        }),
      });
    } catch {
      throw new InstagramLoginDiagnosticError(stage, 'transport');
    }
    if (!response.ok) throw new InstagramLoginRequestError(stage, response.status);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new InstagramLoginDiagnosticError(stage, 'invalid-response');
    }
  }
}
