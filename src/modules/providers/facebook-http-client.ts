import { z } from 'zod';

const idSchema = z.object({ id: z.string().min(1) });
const permalinkSchema = z.object({ permalink_url: z.url() });
const graphIdSchema = z.string().regex(/^[0-9]+(?:_[0-9]+)*$/);
const conversationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]+$/)
  .max(256);
// Graph timestamps commonly use +0000 instead of ISO's +00:00 offset.
const graphTimestampSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid Graph timestamp');
const pagePostSchema = z.object({
  id: graphIdSchema,
  message: z.string().optional(),
  created_time: graphTimestampSchema,
  permalink_url: z.url().optional(),
});
const postCommentSchema = z.object({
  id: graphIdSchema,
  message: z.string().optional(),
  created_time: graphTimestampSchema,
  comment_count: z.number().int().nonnegative().optional(),
  like_count: z.number().int().nonnegative().optional(),
});
const conversationSchema = z.object({
  id: conversationIdSchema,
  updated_time: graphTimestampSchema.optional(),
});
const conversationMessageSchema = z.object({
  id: z.string().min(1).max(256),
  message: z.string().optional(),
  created_time: graphTimestampSchema,
  from: z.object({ id: z.string().min(1).max(256) }).optional(),
});
const graphPageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item).max(100),
    paging: z
      .object({ cursors: z.object({ after: z.string().min(1).max(2048).optional() }).optional() })
      .optional(),
  });
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

  /** Page-owned posts only; visitor content has a separate Meta permission boundary. */
  public async listPagePosts(input: {
    pageId: string;
    accessToken: string;
    limit?: number;
    after?: string;
  }) {
    const pageId = graphIdSchema.parse(input.pageId);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(input.limit ?? 25);
    const after = input.after ? z.string().min(1).max(2048).parse(input.after) : undefined;
    const body = await this.get(
      `/${pageId}/posts`,
      {
        fields: 'id,message,created_time,permalink_url',
        limit: String(limit),
        ...(after ? { after } : {}),
      },
      input.accessToken,
    );
    const page = graphPageSchema(pagePostSchema).parse(body);
    return {
      posts: page.data.map((post) => ({
        id: post.id,
        text: post.message ?? '',
        createdAt: post.created_time,
        permalink: post.permalink_url ?? null,
      })),
      nextCursor: page.paging?.cursors?.after ?? null,
    };
  }

  /** Caller must first prove that postId belongs to its selected Page. */
  public async listPostComments(input: {
    postId: string;
    accessToken: string;
    limit?: number;
    after?: string;
  }) {
    const postId = graphIdSchema.parse(input.postId);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(input.limit ?? 25);
    const after = input.after ? z.string().min(1).max(2048).parse(input.after) : undefined;
    const body = await this.get(
      `/${postId}/comments`,
      {
        fields: 'id,message,created_time,comment_count,like_count',
        limit: String(limit),
        ...(after ? { after } : {}),
      },
      input.accessToken,
    );
    const page = graphPageSchema(postCommentSchema).parse(body);
    return {
      comments: page.data.map((comment) => ({
        id: comment.id,
        text: comment.message ?? '',
        createdAt: comment.created_time,
        replyCount: comment.comment_count ?? null,
        likeCount: comment.like_count ?? null,
      })),
      nextCursor: page.paging?.cursors?.after ?? null,
    };
  }

  /** Messenger Page conversations; Meta does not support time-based pagination here. */
  public async listPageConversations(input: {
    pageId: string;
    accessToken: string;
    limit?: number;
    after?: string;
  }) {
    const pageId = graphIdSchema.parse(input.pageId);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(input.limit ?? 25);
    const after = input.after ? z.string().min(1).max(2048).parse(input.after) : undefined;
    const body = await this.get(
      `/${pageId}/conversations`,
      { fields: 'id,updated_time', limit: String(limit), ...(after ? { after } : {}) },
      input.accessToken,
    );
    const page = graphPageSchema(conversationSchema).parse(body);
    return {
      conversations: page.data.map((item) => ({
        id: item.id,
        updatedAt: item.updated_time ?? null,
      })),
      nextCursor: page.paging?.cursors?.after ?? null,
    };
  }

  /** Transport only: caller must bind the conversation to its selected Page. */
  public async listConversationMessages(input: {
    conversationId: string;
    accessToken: string;
    limit?: number;
    after?: string;
  }) {
    const conversationId = conversationIdSchema.parse(input.conversationId);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(input.limit ?? 25);
    const after = input.after ? z.string().min(1).max(2048).parse(input.after) : undefined;
    const body = await this.get(
      `/${conversationId}/messages`,
      { fields: 'id,message,created_time,from', limit: String(limit), ...(after ? { after } : {}) },
      input.accessToken,
    );
    const page = graphPageSchema(conversationMessageSchema).parse(body);
    return {
      messages: page.data.map((item) => ({
        id: item.id,
        text: item.message ?? '',
        createdAt: item.created_time,
        senderId: item.from?.id ?? null,
      })),
      nextCursor: page.paging?.cursors?.after ?? null,
    };
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
    try {
      return idSchema.parse(await this.responseJson(response)).id;
    } catch (error) {
      if (error instanceof FacebookRequestError) throw error;
      throw new FacebookRequestError({ kind: 'transient', status: response.status }, true);
    }
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
