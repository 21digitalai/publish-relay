import { z } from 'zod';

const API_ORIGIN = 'https://open.tiktokapis.com';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_SECONDS = 86_400;

const oauthTokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  open_id: z.string().min(1),
  scope: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  refresh_expires_in: z.number().int().positive(),
});

const privacySchema = z.enum([
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
]);

const creatorSchema = z.object({
  creator_username: z.string().min(1),
  creator_nickname: z.string().min(1),
  creator_avatar_url: z.url(),
  privacy_level_options: z.array(privacySchema).min(1),
  comment_disabled: z.boolean(),
  duet_disabled: z.boolean(),
  stitch_disabled: z.boolean(),
  max_video_post_duration_sec: z.number().int().positive(),
});

const initSchema = z.object({ publish_id: z.string().min(1).max(64) });
const statusSchema = z.object({
  status: z.enum([
    'PROCESSING_UPLOAD',
    'PROCESSING_DOWNLOAD',
    'SEND_TO_USER_INBOX',
    'PUBLISH_COMPLETE',
    'FAILED',
  ]),
  fail_reason: z.string().optional(),
  publicaly_available_post_id: z.array(z.union([z.string(), z.number().int()])).optional(),
  uploaded_bytes: z.number().int().nonnegative().optional(),
  downloaded_bytes: z.number().int().nonnegative().optional(),
});

const envelopeSchema = z.object({
  data: z.unknown().optional(),
  error: z.object({
    code: z.string().min(1),
    log_id: z.string().optional(),
  }),
});

const oauthErrorSchema = z.object({
  error: z.string().min(1),
  log_id: z.string().optional(),
});

export type TikTokToken = z.infer<typeof oauthTokenSchema>;
export type TikTokCreatorInfo = z.infer<typeof creatorSchema>;
export type TikTokPostStatus = z.infer<typeof statusSchema>;
export type TikTokPrivacy = z.infer<typeof privacySchema>;
export type TikTokErrorKind = 'auth' | 'rate_limit' | 'transient' | 'validation' | 'permanent';

export class TikTokRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly kind: TikTokErrorKind,
    public readonly code?: string,
    public readonly logId?: string,
    public readonly retryAfterSeconds?: number,
    public readonly outcomeUnknown = false,
  ) {
    super(`TikTok request failed (${kind}, HTTP ${String(status)})`);
  }
}

export interface TikTokHttpClientOptions {
  clientKey: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface TikTokDirectPost {
  title: string;
  privacyLevel: TikTokPrivacy;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  brandContent: boolean;
  brandOrganic: boolean;
  isAiGenerated: boolean;
  videoUrl: string;
  coverTimestampMs?: number;
}

function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TikTokRequestError(200, 'permanent');
  return result.data;
}

function safeProviderField(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function classify(status: number, code?: string): TikTokErrorKind {
  if (status === 401 || code === 'access_token_invalid' || code === 'scope_not_authorized')
    return 'auth';
  if (status === 429 || code === 'rate_limit_exceeded') return 'rate_limit';
  if (status >= 500) return 'transient';
  if (status === 400 || status === 422 || code === 'invalid_param') return 'validation';
  return 'permanent';
}

function retryAfter(response: Response, now: number): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const numeric = Number(header);
  const seconds = Number.isFinite(numeric) ? numeric : Math.ceil((Date.parse(header) - now) / 1000);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS)
    : undefined;
}

export class TikTokHttpClient {
  private readonly request: typeof fetch;
  private readonly now: () => number;

  public constructor(private readonly options: TikTokHttpClientOptions) {
    if (!options.clientKey || !options.clientSecret)
      throw new Error('TikTok app credentials are required');
    if (
      options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)
    )
      throw new Error('TikTok timeout must be positive');
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  public async exchangeCode(input: { code: string; redirectUri: string }): Promise<TikTokToken> {
    return this.oauthToken({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
    });
  }

  public async refresh(refreshToken: string): Promise<TikTokToken> {
    return this.oauthToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  public async revoke(accessToken: string): Promise<void> {
    await this.call(
      '/v2/oauth/revoke/',
      new URLSearchParams({
        client_key: this.options.clientKey,
        client_secret: this.options.clientSecret,
        token: accessToken,
      }),
      undefined,
      'oauth',
      false,
      true,
    );
  }

  public async creatorInfo(accessToken: string): Promise<TikTokCreatorInfo> {
    return validated(
      creatorSchema,
      await this.call('/v2/post/publish/creator_info/query/', {}, accessToken),
    );
  }

  public async initDirectPost(
    accessToken: string,
    input: TikTokDirectPost,
  ): Promise<{ publishId: string }> {
    const mediaUrl = new URL(input.videoUrl);
    if (mediaUrl.protocol !== 'https:' || mediaUrl.username || mediaUrl.password || mediaUrl.hash)
      throw new Error('TikTok pull URL must be HTTPS without credentials or fragment');
    const data = validated(
      initSchema,
      await this.call(
        '/v2/post/publish/video/init/',
        {
          post_info: {
            title: input.title,
            privacy_level: input.privacyLevel,
            disable_comment: input.disableComment,
            disable_duet: input.disableDuet,
            disable_stitch: input.disableStitch,
            brand_content_toggle: input.brandContent,
            brand_organic_toggle: input.brandOrganic,
            is_aigc: input.isAiGenerated,
            ...(input.coverTimestampMs === undefined
              ? {}
              : { video_cover_timestamp_ms: input.coverTimestampMs }),
          },
          source_info: { source: 'PULL_FROM_URL', video_url: mediaUrl.toString() },
        },
        accessToken,
        'api',
        true,
      ),
    );
    return { publishId: data.publish_id };
  }

  public async status(accessToken: string, publishId: string): Promise<TikTokPostStatus> {
    return validated(
      statusSchema,
      await this.call('/v2/post/publish/status/fetch/', { publish_id: publishId }, accessToken),
    );
  }

  public async cancel(accessToken: string, publishId: string): Promise<void> {
    await this.call('/v2/post/publish/cancel/', { publish_id: publishId }, accessToken);
  }

  private async oauthToken(fields: Record<string, string>): Promise<TikTokToken> {
    const body = new URLSearchParams({
      client_key: this.options.clientKey,
      client_secret: this.options.clientSecret,
      ...fields,
    });
    return validated(
      oauthTokenSchema,
      await this.call('/v2/oauth/token/', body, undefined, 'oauth'),
    );
  }

  private async call(
    path: string,
    body: object | URLSearchParams,
    accessToken?: string,
    format: 'api' | 'oauth' = 'api',
    init = false,
    emptySuccess = false,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type':
        format === 'oauth'
          ? 'application/x-www-form-urlencoded'
          : 'application/json; charset=UTF-8',
    };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    let response: Response;
    try {
      response = await this.request(`${API_ORIGIN}${path}`, {
        method: 'POST',
        headers,
        body: body instanceof URLSearchParams ? body : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new TikTokRequestError(0, 'transient', undefined, undefined, undefined, init);
    }
    if (response.status >= 300 && response.status < 400)
      throw new TikTokRequestError(response.status, 'permanent');
    if (emptySuccess && response.ok && (await response.clone().text()).trim() === '')
      return undefined;
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new TikTokRequestError(
        response.status,
        classify(response.status),
        undefined,
        undefined,
        undefined,
        init && response.ok,
      );
    }
    const oauthError = format === 'oauth' ? oauthErrorSchema.safeParse(json) : null;
    const envelope = format === 'api' ? envelopeSchema.safeParse(json) : null;
    const code = safeProviderField(
      oauthError?.success
        ? oauthError.data.error
        : envelope?.success
          ? envelope.data.error.code
          : undefined,
    );
    const logId = safeProviderField(
      oauthError?.success
        ? oauthError.data.log_id
        : envelope?.success
          ? envelope.data.error.log_id
          : undefined,
    );
    if (
      !response.ok ||
      oauthError?.success ||
      (envelope?.success && envelope.data.error.code !== 'ok')
    )
      throw new TikTokRequestError(
        response.status,
        classify(response.status, code),
        code,
        logId,
        retryAfter(response, this.now()),
      );
    if (format === 'oauth') return json;
    if (!envelope?.success) throw new TikTokRequestError(response.status, 'permanent');
    return envelope.data.data;
  }
}
