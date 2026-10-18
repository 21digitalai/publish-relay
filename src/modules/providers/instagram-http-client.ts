import { z } from 'zod';

const idSchema = z.object({ id: z.string().min(1) });
const statusSchema = z.object({
  status_code: z.enum(['IN_PROGRESS', 'FINISHED', 'ERROR', 'EXPIRED']),
});
const mediaSchema = z.object({ id: z.string().min(1), permalink: z.url() });

const MAX_RETRY_AFTER_SECONDS = 86_400;

export type InstagramErrorKind =
  'auth' | 'permission' | 'rate_limit' | 'validation' | 'transient' | 'permanent';

export interface InstagramErrorEvidence {
  kind: InstagramErrorKind;
  status: number;
  code?: number;
  subcode?: number;
  isTransient?: boolean;
  retryAfterSeconds?: number;
  traceId?: string;
  appUsage?: string;
  pageUsage?: string;
}

export class InstagramRequestError extends Error {
  public constructor(
    public readonly evidence: InstagramErrorEvidence,
    public readonly outcomeUnknown = false,
    public readonly reconciliationKey?: string,
  ) {
    super(`Instagram request failed (${evidence.kind}, HTTP ${String(evidence.status)})`);
  }
}

export interface InstagramHttpClientOptions {
  graphVersion: string;
  transport?: 'facebook_login' | 'instagram_login';
  fetch?: typeof fetch;
}

function boundedHeader(response: Response, name: string, max = 512): string | undefined {
  const value = response.headers.get(name);
  return value ? value.slice(0, max) : undefined;
}

function retryAfter(response: Response): number | undefined {
  const value = Number(response.headers.get('retry-after'));
  return Number.isFinite(value) && value >= 0
    ? Math.min(value, MAX_RETRY_AFTER_SECONDS)
    : undefined;
}

function errorKind(status: number, code?: number, isTransient?: boolean): InstagramErrorKind {
  if (status === 401 || code === 190) return 'auth';
  if (status === 403 || code === 10 || code === 200) return 'permission';
  if (status === 429 || code === 4 || code === 17 || code === 32 || code === 613)
    return 'rate_limit';
  if (isTransient || status >= 500) return 'transient';
  if (status === 400) return 'validation';
  return 'permanent';
}

export class InstagramHttpClient {
  private readonly request: typeof fetch;
  private readonly origin: string;

  public constructor(private readonly options: InstagramHttpClientOptions) {
    if (!/^v\d+\.\d+$/.test(options.graphVersion))
      throw new Error('Meta Graph API version must be pinned');
    this.request = options.fetch ?? fetch;
    this.origin =
      options.transport === 'instagram_login'
        ? 'https://graph.instagram.com'
        : 'https://graph.facebook.com';
  }

  public async createImageContainer(input: {
    accountId: string;
    imageUrl: string;
    caption?: string;
    isCarouselItem: boolean;
    accessToken: string;
  }): Promise<string> {
    const fields: Record<string, string> = { image_url: input.imageUrl };
    if (input.caption !== undefined) fields.caption = input.caption;
    if (input.isCarouselItem) fields.is_carousel_item = 'true';
    return (await this.post(`/${input.accountId}/media`, fields, input.accessToken, true)).id;
  }

  public async createCarouselContainer(input: {
    accountId: string;
    childIds: readonly string[];
    caption: string;
    accessToken: string;
  }): Promise<string> {
    return (
      await this.post(
        `/${input.accountId}/media`,
        { media_type: 'CAROUSEL', children: input.childIds.join(','), caption: input.caption },
        input.accessToken,
        true,
      )
    ).id;
  }

  public async getContainerStatus(containerId: string, accessToken: string) {
    return statusSchema.parse(
      await this.get(`/${containerId}`, { fields: 'status_code' }, accessToken),
    );
  }

  public async publish(
    accountId: string,
    creationId: string,
    accessToken: string,
  ): Promise<string> {
    return (
      await this.post(`/${accountId}/media_publish`, { creation_id: creationId }, accessToken, true)
    ).id;
  }

  public async getMedia(mediaId: string, accessToken: string) {
    return mediaSchema.parse(
      await this.get(`/${mediaId}`, { fields: 'id,permalink' }, accessToken),
    );
  }

  private url(path: string, fields: Record<string, string>): URL {
    const url = new URL(`${this.origin}/${this.options.graphVersion}${path}`);
    for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, value);
    return url;
  }

  private async get(
    path: string,
    fields: Record<string, string>,
    accessToken: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(this.url(path, fields), {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      });
    } catch {
      throw new InstagramRequestError({ kind: 'transient', status: 0 });
    }
    return this.responseJson(response);
  }

  private async post(
    path: string,
    fields: Record<string, string>,
    accessToken: string,
    outcomeMayBeUnknown: boolean,
  ) {
    let response: Response;
    try {
      response = await this.request(this.url(path, {}), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(fields),
      });
    } catch {
      throw new InstagramRequestError({ kind: 'transient', status: 0 }, outcomeMayBeUnknown);
    }
    return idSchema.parse(await this.responseJson(response));
  }

  private async responseJson(response: Response): Promise<unknown> {
    const body = (await response.json().catch(() => null)) as {
      error?: {
        code?: number;
        error_subcode?: number;
        is_transient?: boolean;
        fbtrace_id?: string;
      };
    } | null;
    if (response.ok) return body;
    const provider = body?.error;
    const retry = retryAfter(response);
    const appUsage = boundedHeader(response, 'x-app-usage');
    const pageUsage = boundedHeader(response, 'x-page-usage');
    throw new InstagramRequestError({
      kind: errorKind(response.status, provider?.code, provider?.is_transient),
      status: response.status,
      ...(provider?.code === undefined ? {} : { code: provider.code }),
      ...(provider?.error_subcode === undefined ? {} : { subcode: provider.error_subcode }),
      ...(provider?.is_transient === undefined ? {} : { isTransient: provider.is_transient }),
      ...(provider?.fbtrace_id ? { traceId: provider.fbtrace_id.slice(0, 128) } : {}),
      ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
      ...(appUsage ? { appUsage } : {}),
      ...(pageUsage ? { pageUsage } : {}),
    });
  }
}
