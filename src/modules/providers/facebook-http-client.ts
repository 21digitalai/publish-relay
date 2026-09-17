import { z } from 'zod';

const idSchema = z.object({ id: z.string().min(1) });
const permalinkSchema = z.object({ permalink_url: z.url() });
const MAX_RETRY_AFTER_SECONDS = 86_400;

export type FacebookErrorKind =
  'auth' | 'permission' | 'rate_limit' | 'validation' | 'transient' | 'permanent';

export interface FacebookErrorEvidence {
  kind: FacebookErrorKind;
  status: number;
  code?: number;
  subcode?: number;
  isTransient?: boolean;
  retryAfterSeconds?: number;
  traceId?: string;
  appUsage?: string;
  pageUsage?: string;
  permalinkSource?: 'authoritative' | 'derived';
}

export class FacebookRequestError extends Error {
  public constructor(
    public readonly evidence: FacebookErrorEvidence,
    public readonly outcomeUnknown = false,
  ) {
    super(`Facebook request failed (${evidence.kind}, HTTP ${String(evidence.status)})`);
  }
}

function boundedHeader(response: Response, name: string): string | undefined {
  const value = response.headers.get(name);
  return value ? value.slice(0, 512) : undefined;
}

function classify(status: number, code?: number, transient?: boolean): FacebookErrorKind {
  if (status === 401 || code === 190) return 'auth';
  if (status === 403 || code === 10 || code === 200) return 'permission';
  if (status === 429 || [4, 17, 32, 613].includes(code ?? -1)) return 'rate_limit';
  if (transient || status >= 500) return 'transient';
  return status === 400 ? 'validation' : 'permanent';
}

export class FacebookHttpClient {
  private readonly request: typeof fetch;
  private readonly origin = 'https://graph.facebook.com';

  public constructor(private readonly options: { graphVersion: string; fetch?: typeof fetch }) {
    if (!/^v\d+\.\d+$/.test(options.graphVersion))
      throw new Error('Meta Graph API version must be pinned');
    this.request = options.fetch ?? fetch;
  }

  public publishLink(input: {
    pageId: string;
    link: string;
    message?: string;
    accessToken: string;
  }): Promise<string> {
    return this.create(
      `/${input.pageId}/feed`,
      {
        link: input.link,
        ...(input.message ? { message: input.message } : {}),
      },
      input.accessToken,
    );
  }

  public publishPhoto(input: {
    pageId: string;
    imageUrl: string;
    message: string;
    accessToken: string;
  }): Promise<string> {
    return this.create(
      `/${input.pageId}/photos`,
      { url: input.imageUrl, caption: input.message, published: 'true' },
      input.accessToken,
    );
  }

  public async getPermalink(postId: string, accessToken: string): Promise<string> {
    const body = await this.get(`/${postId}`, { fields: 'permalink_url' }, accessToken);
    return permalinkSchema.parse(body).permalink_url;
  }

  private url(path: string, fields: Record<string, string>): URL {
    const url = new URL(`${this.origin}/${this.options.graphVersion}${path}`);
    for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, value);
    return url;
  }

  private async create(
    path: string,
    fields: Record<string, string>,
    accessToken: string,
  ): Promise<string> {
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
      throw new FacebookRequestError({ kind: 'transient', status: 0 }, true);
    }
    return idSchema.parse(await this.responseJson(response)).id;
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
      throw new FacebookRequestError({ kind: 'transient', status: 0 });
    }
    return this.responseJson(response);
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
    const retryValue = Number(response.headers.get('retry-after'));
    const retryAfterSeconds = Number.isFinite(retryValue)
      ? Math.min(Math.max(0, retryValue), MAX_RETRY_AFTER_SECONDS)
      : undefined;
    const appUsage = boundedHeader(response, 'x-app-usage');
    const pageUsage = boundedHeader(response, 'x-page-usage');
    throw new FacebookRequestError({
      kind: classify(response.status, provider?.code, provider?.is_transient),
      status: response.status,
      ...(provider?.code === undefined ? {} : { code: provider.code }),
      ...(provider?.error_subcode === undefined ? {} : { subcode: provider.error_subcode }),
      ...(provider?.is_transient === undefined ? {} : { isTransient: provider.is_transient }),
      ...(provider?.fbtrace_id ? { traceId: provider.fbtrace_id.slice(0, 128) } : {}),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      ...(appUsage ? { appUsage } : {}),
      ...(pageUsage ? { pageUsage } : {}),
    });
  }
}
