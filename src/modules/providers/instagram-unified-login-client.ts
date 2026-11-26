import { z } from 'zod';

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
});
const meSchema = z.object({ id: z.string().min(1), client_business_id: z.string().min(1) });
const accountsSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1), username: z.string().min(1) })),
  paging: z.object({ next: z.url().optional() }).optional(),
});

const MAX_ACCOUNT_PAGES = 20;

export interface InstagramUnifiedLoginAccount {
  id: string;
  username: string;
}

export interface InstagramUnifiedLoginGrant {
  accessToken: string;
  appScopedUserId: string;
  clientBusinessId: string;
  accounts: InstagramUnifiedLoginAccount[];
  expiresAt?: Date;
}

export class InstagramUnifiedLoginError extends Error {
  public constructor(
    public readonly stage: 'token-exchange' | 'business-lookup' | 'account-discovery',
    public readonly category: 'transport' | 'provider' | 'invalid-response',
    public readonly providerCode?: number,
    public readonly providerSubcode?: number,
  ) {
    super(`Instagram Unified Login ${stage} failed (${category})`);
  }
}

export class InstagramUnifiedLoginClient {
  private readonly request: typeof fetch;
  private readonly now: () => number;

  public constructor(
    private readonly options: {
      appId: string;
      appSecret: string;
      configId: string;
      graphVersion: string;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {
    if (
      !options.appId ||
      !options.appSecret ||
      !options.configId ||
      !/^v\d+\.\d+$/.test(options.graphVersion)
    )
      throw new Error(
        'Instagram Unified Login requires app credentials, config_id, and a pinned Graph version',
      );
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  public authorizationUrl(input: { redirectUri: string; state: string }): string {
    const url = new URL(`https://www.facebook.com/${this.options.graphVersion}/dialog/oauth`);
    url.search = new URLSearchParams({
      client_id: this.options.appId,
      config_id: this.options.configId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      display: 'popup',
      prompt: 'login',
      state: input.state,
    }).toString();
    return url.toString();
  }

  public async exchangeCode(input: {
    code: string;
    redirectUri: string;
  }): Promise<InstagramUnifiedLoginGrant> {
    const url = new URL(
      `https://graph.facebook.com/${this.options.graphVersion}/oauth/access_token`,
    );
    url.search = new URLSearchParams({
      client_id: this.options.appId,
      client_secret: this.options.appSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }).toString();
    const token = await this.getJson(url, 'token-exchange', tokenSchema);
    const me = await this.getJson(
      this.graphUrl('/me', { fields: 'client_business_id' }),
      'business-lookup',
      meSchema,
      token.access_token,
    );
    const accounts = await this.discoverAccounts(token.access_token);
    return {
      accessToken: token.access_token,
      appScopedUserId: me.id,
      clientBusinessId: me.client_business_id,
      accounts,
      ...(token.expires_in ? { expiresAt: new Date(this.now() + token.expires_in * 1000) } : {}),
    };
  }

  private async discoverAccounts(accessToken: string): Promise<InstagramUnifiedLoginAccount[]> {
    const accounts: InstagramUnifiedLoginAccount[] = [];
    // Meta's v27 reference declares that this edge has no query parameters.
    let next: string | undefined = this.graphUrl('/me/assigned_instagram_accounts', {}).toString();
    for (let page = 0; next && page < MAX_ACCOUNT_PAGES; page += 1) {
      const result: z.infer<typeof accountsSchema> = await this.getJson(
        new URL(next),
        'account-discovery',
        accountsSchema,
        accessToken,
      );
      accounts.push(...result.data);
      next = result.paging?.next;
    }
    return accounts;
  }

  private graphUrl(path: string, fields: Record<string, string>): URL {
    const url = new URL(`https://graph.facebook.com/${this.options.graphVersion}${path}`);
    for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
    return url;
  }

  private async getJson<T>(
    url: URL,
    stage: InstagramUnifiedLoginError['stage'],
    schema: z.ZodType<T>,
    accessToken?: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.request(url, {
        headers: {
          accept: 'application/json',
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new InstagramUnifiedLoginError(stage, 'transport');
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z
        .object({
          error: z
            .object({
              code: z.number().int().optional(),
              error_subcode: z.number().int().optional(),
            })
            .optional(),
        })
        .safeParse(body);
      throw new InstagramUnifiedLoginError(
        stage,
        'provider',
        error.success ? error.data.error?.code : undefined,
        error.success ? error.data.error?.error_subcode : undefined,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new InstagramUnifiedLoginError(stage, 'invalid-response');
    return parsed.data;
  }
}
