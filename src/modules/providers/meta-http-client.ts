import { z } from 'zod';

export const META_PERMISSIONS = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
] as const;

export type MetaPermission = (typeof META_PERMISSIONS)[number];

export type MetaGrantFamily = 'facebook_pages' | 'instagram';

export const META_FAMILY_PERMISSIONS: Record<MetaGrantFamily, readonly MetaPermission[]> = {
  facebook_pages: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
  instagram: [
    'pages_show_list',
    'pages_read_engagement',
    'instagram_basic',
    'instagram_content_publish',
  ],
};

export function parseMetaFamilyPermissions(
  family: MetaGrantFamily,
  value: string | undefined,
): MetaPermission[] {
  if (!value) throw new Error(`Meta ${family} permissions must be explicitly verified`);
  const permission = z.enum(META_PERMISSIONS);
  const parsed = [...new Set(value.split(',').map((item) => permission.parse(item.trim())))];
  const expected = META_FAMILY_PERMISSIONS[family];
  if (parsed.length !== expected.length || expected.some((item) => !parsed.includes(item)))
    throw new Error(`Meta ${family} permissions do not match the family allowlist`);
  return parsed;
}

export function parseMetaPermissions(value?: string): MetaPermission[] {
  if (!value) return [...META_PERMISSIONS];
  const permission = z.enum(META_PERMISSIONS);
  const parsed = [...new Set(value.split(',').map((item) => permission.parse(item.trim())))];
  const missing = META_PERMISSIONS.filter((item) => !parsed.includes(item));
  if (missing.length > 0) throw new Error('Meta permission configuration is incomplete');
  return parsed;
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
});

const debugSchema = z.object({
  data: z.object({
    is_valid: z.boolean(),
    app_id: z.string().min(1),
    user_id: z.string().min(1),
    expires_at: z.number().int().nonnegative().optional(),
    scopes: z.array(z.string()).default([]),
  }),
});

const pageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  access_token: z.string().min(1),
  tasks: z.array(z.string()).default([]),
  instagram_business_account: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      username: z.string().optional(),
    })
    .optional(),
});

const pagesSchema = z.object({
  data: z.array(pageSchema),
  paging: z
    .object({ cursors: z.object({ after: z.string().min(1).optional() }).optional() })
    .optional(),
});

const MAX_DISCOVERY_PAGES = 20;
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

export type MetaRequestErrorKind = 'auth' | 'permission' | 'rate_limit' | 'transient' | 'permanent';

export class MetaRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly kind: MetaRequestErrorKind,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`Meta request failed (${kind}, HTTP ${String(status)})`);
  }
}

export interface MetaCredential {
  accessToken: string;
  userId: string;
  expiresAt?: string;
  scopes: MetaPermission[];
}

export interface MetaDiscoveredPage {
  id: string;
  name: string;
  accessToken: string;
  tasks: string[];
  instagram?: { id: string; name: string; username?: string };
}

export interface MetaHttpClientOptions {
  appId: string;
  appSecret: string;
  graphVersion: string;
  permissions?: readonly MetaPermission[];
  fetch?: typeof fetch;
  now?: () => number;
}

function parseRetryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

function classify(status: number): MetaRequestErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'transient';
  return 'permanent';
}

export class MetaHttpClient {
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly permissions: readonly MetaPermission[];
  private readonly graphOrigin = 'https://graph.facebook.com';
  private readonly authorizationOrigin = 'https://www.facebook.com';

  public constructor(private readonly options: MetaHttpClientOptions) {
    if (!options.appId || !options.appSecret) throw new Error('Meta app credentials are required');
    if (!/^v\d+\.\d+$/.test(options.graphVersion))
      throw new Error('Meta Graph API version must be pinned (for example v23.0)');
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.permissions = options.permissions ?? META_PERMISSIONS;
  }

  public authorizationUrl(input: {
    redirectUri: string;
    state: string;
    permissions?: readonly MetaPermission[];
  }): string {
    const url = new URL(`${this.authorizationOrigin}/${this.options.graphVersion}/dialog/oauth`);
    url.search = new URLSearchParams({
      client_id: this.options.appId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: (input.permissions ?? this.permissions).join(','),
      state: input.state,
    }).toString();
    return url.toString();
  }

  public async exchangeCode(input: {
    code: string;
    redirectUri: string;
    permissions?: readonly MetaPermission[];
  }): Promise<MetaCredential> {
    const shortToken = await this.tokenRequest('/oauth/access_token', {
      client_id: this.options.appId,
      client_secret: this.options.appSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
    });
    const longToken = await this.tokenRequest('/oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: this.options.appId,
      client_secret: this.options.appSecret,
      fb_exchange_token: shortToken.access_token,
    });
    return this.validateCredential(longToken, input.permissions);
  }

  public async validateCredential(
    token: z.infer<typeof tokenSchema>,
    permissions: readonly MetaPermission[] = this.permissions,
  ): Promise<MetaCredential> {
    const response = await this.request(this.url('/debug_token'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        input_token: token.access_token,
        access_token: `${this.options.appId}|${this.options.appSecret}`,
      }),
    });
    const debug = debugSchema.parse(await this.responseJson(response));
    if (!debug.data.is_valid || debug.data.app_id !== this.options.appId)
      throw new MetaRequestError(401, 'auth');
    const missing = permissions.filter((permission) => !debug.data.scopes.includes(permission));
    if (missing.length > 0) throw new MetaRequestError(403, 'permission');
    const expiresAtSeconds = debug.data.expires_at;
    if (expiresAtSeconds && expiresAtSeconds * 1000 <= this.now())
      throw new MetaRequestError(401, 'auth');
    return {
      accessToken: token.access_token,
      userId: debug.data.user_id,
      ...(expiresAtSeconds
        ? { expiresAt: new Date(expiresAtSeconds * 1000).toISOString() }
        : token.expires_in
          ? { expiresAt: new Date(this.now() + token.expires_in * 1000).toISOString() }
          : {}),
      scopes: [...permissions],
    };
  }

  public async discoverPages(
    accessToken: string,
    family?: MetaGrantFamily,
  ): Promise<MetaDiscoveredPage[]> {
    const pages: MetaDiscoveredPage[] = [];
    let after: string | undefined;
    for (let pageNumber = 0; pageNumber < MAX_DISCOVERY_PAGES; pageNumber += 1) {
      const url = this.url('/me/accounts');
      url.searchParams.set(
        'fields',
        family === 'facebook_pages'
          ? 'id,name,tasks,access_token'
          : 'id,name,tasks,access_token,instagram_business_account{id,name,username}',
      );
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after', after);
      const response = await this.request(url, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      });
      const body = pagesSchema.parse(await this.responseJson(response));
      pages.push(
        ...body.data.map((page) => ({
          id: page.id,
          name: page.name,
          accessToken: page.access_token,
          tasks: [...page.tasks],
          ...(page.instagram_business_account
            ? {
                instagram: {
                  id: page.instagram_business_account.id,
                  name:
                    page.instagram_business_account.username ??
                    page.instagram_business_account.name ??
                    page.instagram_business_account.id,
                  ...(page.instagram_business_account.username
                    ? { username: page.instagram_business_account.username }
                    : {}),
                },
              }
            : {}),
        })),
      );
      const next = body.paging?.cursors?.after;
      if (!next || next === after) return pages;
      after = next;
    }
    throw new MetaRequestError(502, 'permanent');
  }

  public async revoke(accessToken: string): Promise<void> {
    const response = await this.request(this.url('/me/permissions'), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    await this.responseJson(response);
  }

  private url(path: string): URL {
    return new URL(`${this.graphOrigin}/${this.options.graphVersion}${path}`);
  }

  private async tokenRequest(path: string, fields: Record<string, string>) {
    const response = await this.request(this.url(path), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields),
    });
    return tokenSchema.parse(await this.responseJson(response));
  }

  private async responseJson(response: Response): Promise<unknown> {
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok)
      throw new MetaRequestError(
        response.status,
        classify(response.status),
        parseRetryAfter(response),
      );
    return body;
  }
}
