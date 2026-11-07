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
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid Graph timestamp');
const pagePostSchema = z.object({
  id: graphIdSchema,
  message: z.string().optional(),
  created_time: graphTimestampSchema,
  permalink_url: z.url().optional(),
});
const postOwnerSchema = z.object({
  id: graphIdSchema,
  from: z.object({ id: graphIdSchema }),
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
  link: z.string().max(2048).optional(),
  updated_time: graphTimestampSchema.optional(),
  participants: z
    .object({
      data: z
        .array(
          z.object({
            id: z.string().min(1).max(256),
            name: z.string().min(1).max(256).optional(),
          }),
        )
        .max(10),
    })
    .optional(),
});
const conversationParticipantsSchema = z.object({
  id: conversationIdSchema,
  link: z.string().max(2048).optional(),
  participants: z.object({
    data: z
      .array(
        z.object({
          id: z.string().min(1).max(256),
          name: z.string().min(1).max(256).optional(),
        }),
      )
      .min(2)
      .max(10),
  }),
});
function canonicalMessengerLink(value: string | undefined): string | null {
  if (!value) return null;
  try {
    if (!value.startsWith('/') && !value.startsWith('https://')) return null;
    const url = new URL(value, 'https://www.facebook.com');
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      !['facebook.com', 'messenger.com', 'm.me'].some(
        (domain) => host === domain || host.endsWith(`.${domain}`),
      )
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}
const conversationMessageSchema = z.object({
  id: z.string().min(1).max(256),
  message: z.string().optional(),
  created_time: graphTimestampSchema,
  from: z.object({ id: z.string().min(1).max(256) }).optional(),
});
const sentMessageSchema = z.object({
  recipient_id: z.string().min(1).max(256),
  message_id: z.string().min(1).max(256),
});
const graphPageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item).max(100),
    paging: z
      .object({
        cursors: z.object({ after: z.string().min(1).max(2048).optional() }).optional(),
        next: z.string().min(1).optional(),
      })
      .optional(),
  });
const MAX_RETRY_AFTER_SECONDS = 86_400;
const MAX_MESSAGE_TEXT_BYTES = 16 * 1024;
const MAX_MESSAGE_PAGE_BYTES = 64 * 1024;
const MAX_COMMENT_ANCESTRY_DEPTH = 10;
const MAX_POST_COMMENT_PROOF_PAGES = 10;

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
  if (status === 429 || [4, 17, 32, 613].includes(code ?? -1)) return 'rate_limit';
  if (status === 403 || code === 10 || code === 200) return 'permission';
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
      nextCursor: page.paging?.next ? (page.paging.cursors?.after ?? null) : null,
    };
  }

  /** Raw Graph post author is used only for the selected Page ownership check. */
  public async getPostOwner(postId: string, accessToken: string): Promise<string> {
    const id = graphIdSchema.parse(postId);
    const body = await this.get(`/${id}`, { fields: 'id,from{id}' }, accessToken);
    const post = postOwnerSchema.safeParse(body);
    if (!post.success || post.data.id !== id)
      throw new FacebookRequestError({ kind: 'permanent', status: 502 });
    return post.data.from.id;
  }

  /** Prove ancestry through parent edges or exact membership in the selected post's comments edge. */
  public async isCommentUnderPost(
    commentId: string,
    postId: string,
    accessToken: string,
  ): Promise<boolean> {
    let current = graphIdSchema.parse(commentId);
    const target = graphIdSchema.parse(postId);
    const seen = new Set<string>();
    for (let depth = 0; depth < MAX_COMMENT_ANCESTRY_DEPTH; depth += 1) {
      if (seen.has(current)) return false;
      seen.add(current);
      const body = await this.get(`/${current}`, { fields: 'id,parent{id}' }, accessToken);
      const node = z
        .object({
          id: graphIdSchema,
          parent: z.object({ id: graphIdSchema }).optional(),
        })
        .safeParse(body);
      if (!node.success || node.data.id !== current) return false;
      if (!node.data.parent) return this.isDirectPostComment(current, target, accessToken);
      const parent = node.data.parent.id;
      if (parent === target) return true;
      current = parent;
    }
    return false;
  }

  private async isDirectPostComment(
    commentId: string,
    postId: string,
    accessToken: string,
  ): Promise<boolean> {
    let after: string | undefined;
    const cursors = new Set<string>();
    for (let pageNumber = 0; pageNumber < MAX_POST_COMMENT_PROOF_PAGES; pageNumber += 1) {
      const body = await this.get(
        `/${postId}/comments`,
        { fields: 'id', limit: '100', ...(after ? { after } : {}) },
        accessToken,
      );
      const page = graphPageSchema(z.object({ id: graphIdSchema })).safeParse(body);
      if (!page.success) return false;
      if (page.data.data.some((comment) => comment.id === commentId)) return true;
      if (!page.data.paging?.next) return false;
      const next = page.data.paging.cursors?.after;
      if (!next || cursors.has(next)) return false;
      cursors.add(next);
      after = next;
    }
    return false;
  }

  /** A confirmed Graph ID is the only successful reply receipt. */
  public async replyToComment(input: {
    commentId: string;
    text: string;
    accessToken: string;
  }): Promise<string> {
    const commentId = graphIdSchema.parse(input.commentId);
    const text = z.string().trim().min(1).max(2000).parse(input.text);
    return this.create(`/${commentId}/comments`, { message: text }, input.accessToken);
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
      nextCursor: page.paging?.next ? (page.paging.cursors?.after ?? null) : null,
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
      {
        fields: 'id,link,updated_time,participants{id,name}',
        limit: String(limit),
        ...(after ? { after } : {}),
      },
      input.accessToken,
    );
    const page = graphPageSchema(conversationSchema).parse(body);
    return {
      conversations: page.data.map((item) => ({
        id: item.id,
        link: canonicalMessengerLink(item.link),
        updatedAt: item.updated_time ?? null,
        displayName: this.pageParticipantName(item.participants?.data, pageId),
      })),
      nextCursor: page.paging?.next ? (page.paging.cursors?.after ?? null) : null,
    };
  }

  private pageParticipantName(
    participants: { id: string; name?: string | undefined }[] | undefined,
    pageId: string,
  ): string | null {
    if (participants?.filter((item) => item.id === pageId).length !== 1) return null;
    const people = participants.filter((item) => item.id !== pageId);
    return people.length === 1 ? (people[0]?.name ?? null) : null;
  }

  /** Resolve the exact conversation with only bounded participant identity. */
  public async getConversationDetails(conversationId: string, accessToken: string) {
    const id = conversationIdSchema.parse(conversationId);
    const body = await this.get(`/${id}`, { fields: 'id,link,participants{id,name}' }, accessToken);
    const conversation = conversationParticipantsSchema.safeParse(body);
    if (!conversation.success || conversation.data.id !== id)
      throw new FacebookRequestError({ kind: 'permanent', status: 502 });
    return {
      participants: conversation.data.participants.data,
      link: canonicalMessengerLink(conversation.data.link),
    };
  }

  /** Only used when Graph omits a conversation link; never guess a thread URL. */
  public async getPageUsername(pageId: string, accessToken: string): Promise<string | null> {
    const id = graphIdSchema.parse(pageId);
    const body = await this.get(`/${id}`, { fields: 'id,username' }, accessToken);
    const page = z
      .object({ id: graphIdSchema, username: z.string().nullable().optional() })
      .parse(body);
    if (page.id !== id || !page.username || !/^[A-Za-z0-9.]+$/.test(page.username)) return null;
    return page.username;
  }

  public async getConversationParticipants(conversationId: string, accessToken: string) {
    const id = conversationIdSchema.parse(conversationId);
    const body = await this.get(`/${id}`, { fields: 'id,participants{id,name}' }, accessToken);
    const conversation = conversationParticipantsSchema.safeParse(body);
    if (!conversation.success || conversation.data.id !== id)
      throw new FacebookRequestError({ kind: 'permanent', status: 502 });
    return conversation.data.participants.data;
  }

  /** Ownership-only projection for the send preflight. */
  public async getConversationParticipantIds(
    conversationId: string,
    accessToken: string,
  ): Promise<string[]> {
    const id = conversationIdSchema.parse(conversationId);
    const body = await this.get(`/${id}`, { fields: 'id,participants{id}' }, accessToken);
    const conversation = conversationParticipantsSchema.safeParse(body);
    if (!conversation.success || conversation.data.id !== id)
      throw new FacebookRequestError({ kind: 'permanent', status: 502 });
    return conversation.data.participants.data.map((participant) => participant.id);
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
    if (
      page.data.some(
        (item) => Buffer.byteLength(item.message ?? '', 'utf8') > MAX_MESSAGE_TEXT_BYTES,
      )
    )
      throw new FacebookRequestError({ kind: 'permanent', status: 502 });
    const result = {
      messages: page.data.map((item) => ({
        id: item.id,
        text: item.message ?? '',
        createdAt: item.created_time,
        senderId: item.from?.id ?? null,
      })),
      nextCursor: page.paging?.next ? (page.paging.cursors?.after ?? null) : null,
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_MESSAGE_PAGE_BYTES)
      throw new FacebookRequestError({ kind: 'permanent', status: 502 });
    return result;
  }

  /** Only a verified Page-scoped conversation may supply recipientId. */
  public async sendPageMessage(input: {
    pageId: string;
    recipientId: string;
    text: string;
    accessToken: string;
  }): Promise<string> {
    const pageId = graphIdSchema.parse(input.pageId);
    const recipientId = z.string().min(1).max(256).parse(input.recipientId);
    const text = z.string().min(1).max(2000).parse(input.text);
    let response: Response;
    try {
      response = await this.request(this.url(`/${pageId}/messages`, {}), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { id: recipientId },
          messaging_type: 'RESPONSE',
          message: { text },
        }),
      });
    } catch {
      throw new FacebookRequestError({ kind: 'transient', status: 0 }, true);
    }
    const body = await this.responseJson(response);
    if (!response.ok) throw new Error('Unreachable Facebook response state');
    const parsed = sentMessageSchema.safeParse(body);
    if (!parsed.success || parsed.data.recipient_id !== recipientId)
      throw new FacebookRequestError({ kind: 'permanent', status: 502 }, true);
    return parsed.data.message_id;
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
