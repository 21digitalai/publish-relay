import { z } from 'zod';

const graphId = z.string().min(1).max(256);
const timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));
const page = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item).max(100),
    paging: z
      .object({
        next: z.url().optional(),
        cursors: z.object({ after: z.string().min(1).max(2048).optional() }).optional(),
      })
      .optional(),
  });
const media = z.object({
  id: graphId,
  media_type: z.string().min(1).max(32),
  media_url: z.url().optional(),
  permalink: z.url().optional(),
  timestamp,
  caption: z.string().max(2200).optional(),
  comments_count: z.number().int().nonnegative().optional(),
});
const comment = z.object({
  id: graphId,
  text: z.string().max(2200).optional(),
  timestamp,
  username: z.string().max(256).optional(),
  from: z.object({ id: graphId, username: z.string().max(256).optional() }).optional(),
});
const ownedMedia = z.object({ id: graphId, owner: z.object({ id: graphId }) });
const permission = z.object({ permission: z.string().min(1).max(128), status: z.string().min(1).max(32) });
const conversation = z.object({
  id: graphId,
  updated_time: timestamp.optional(),
  participants: z.object({ data: z.array(z.object({ id: graphId, username: z.string().max(256).optional() })).max(20) }).optional(),
});
const message = z.object({
  id: graphId,
  created_time: timestamp,
  from: z.object({ id: graphId, username: z.string().max(256).optional() }).optional(),
  message: z.string().max(2200).optional(),
});

const MAX_PAGES = 20;

export type InstagramUnifiedReadErrorKind =
  'auth' | 'permission' | 'rate_limit' | 'validation' | 'transient' | 'permanent';

export class InstagramUnifiedReadError extends Error {
  public constructor(
    public readonly kind: InstagramUnifiedReadErrorKind,
    public readonly status: number,
    public readonly providerCode?: number,
    public readonly providerSubcode?: number,
  ) {
    super(`Instagram Unified read failed (${kind}, HTTP ${String(status)})`);
  }
}

export class InstagramUnifiedReadClient {
  private readonly request: typeof fetch;

  public constructor(private readonly options: { graphVersion: string; fetch?: typeof fetch }) {
    if (!/^v\d+\.\d+$/.test(options.graphVersion))
      throw new Error('Meta Graph API version must be pinned');
    this.request = options.fetch ?? fetch;
  }

  public listMedia(input: {
    accountId: string;
    accessToken: string;
    limit?: number;
    after?: string;
  }) {
    return this.list(
      input,
      `/${this.id(input.accountId)}/media`,
      {
        fields: 'id,media_type,media_url,permalink,timestamp,caption,comments_count',
        ...(input.limit === undefined ? {} : { limit: this.limit(input.limit) }),
        ...(input.after ? { after: this.cursor(input.after) } : {}),
      },
      media,
    ).then((result) => ({
      media: result.items.map((item) => ({
        id: item.id,
        type: item.media_type,
        url: item.media_url ?? null,
        permalink: item.permalink ?? null,
        timestamp: item.timestamp,
        caption: item.caption ?? '',
        commentsCount: item.comments_count ?? 0,
      })),
      nextCursor: result.nextCursor,
    }));
  }

  public async verifyPermissions(accessToken: string) {
    const body = await this.get(this.url('/me/permissions', {}), accessToken);
    const parsed = z.object({ data: z.array(permission).max(100) }).safeParse(body);
    if (!parsed.success) throw new InstagramUnifiedReadError('permanent', 502);
    const required = ['instagram_basic', 'instagram_manage_comments'];
    return required.reduce<Record<string, 'granted' | 'missing' | 'declined'>>((result, name) => {
      const row = parsed.data.data.find((item) => item.permission === name);
      result[name] = row?.status === 'granted' ? 'granted' : row?.status === 'declined' ? 'declined' : 'missing';
      return result;
    }, {});
  }

  public async verifyMessagingPermission(accessToken: string) {
    const body = await this.get(this.url('/me/permissions', {}), accessToken);
    const parsed = z.object({ data: z.array(permission).max(100) }).safeParse(body);
    if (!parsed.success) throw new InstagramUnifiedReadError('permanent', 502);
    const row = parsed.data.data.find((item) => item.permission === 'instagram_manage_messages');
    return row?.status === 'granted' ? 'granted' : row?.status === 'declined' ? 'declined' : 'missing';
  }

  public listConversations(input: { accountId: string; accessToken: string; limit?: number; after?: string }) {
    return this.list(input, `/${this.id(input.accountId)}/conversations`, {
      fields: 'id,updated_time,participants{id,username}',
      ...(input.limit === undefined ? {} : { limit: this.limit(input.limit) }),
      ...(input.after ? { after: this.cursor(input.after) } : {}),
    }, conversation).then((result) => ({
      conversations: result.items.map((item) => ({
        id: item.id,
        updatedAt: item.updated_time ?? null,
        participants: (item.participants?.data ?? []).map((participant) => ({ id: participant.id, username: participant.username ?? null })),
      })),
      nextCursor: result.nextCursor,
    }));
  }

  public listMessages(input: { accountId: string; conversationId: string; accessToken: string; limit?: number; after?: string }) {
    return this.assertConversationOwner(input).then(() => this.list(input, `/${this.id(input.conversationId)}/messages`, {
      fields: 'id,created_time,from{id,username},message',
      ...(input.limit === undefined ? {} : { limit: this.limit(input.limit) }),
      ...(input.after ? { after: this.cursor(input.after) } : {}),
    }, message)).then((result) => ({
      messages: result.items.map((item) => ({ id: item.id, createdAt: item.created_time, senderId: item.from?.id ?? null, senderUsername: item.from?.username ?? null, text: item.message ?? '' })),
      nextCursor: result.nextCursor,
    }));
  }

  private async assertConversationOwner(input: { accountId: string; conversationId: string; accessToken: string }) {
    const body = await this.get(this.url(`/${this.id(input.conversationId)}`, { fields: 'id,participants{id}' }), input.accessToken);
    const parsed = conversation.safeParse(body);
    if (!parsed.success || parsed.data.id !== input.conversationId || !parsed.data.participants?.data.some((participant) => participant.id === input.accountId))
      throw new InstagramUnifiedReadError('permission', 403);
  }

  public listComments(input: {
    accountId: string;
    mediaId: string;
    accessToken: string;
    limit?: number;
    after?: string;
  }) {
    return this.assertMediaOwner(input).then(() =>
      this.list(
        input,
        `/${this.id(input.mediaId)}/comments`,
        {
          fields: 'id,text,timestamp,username,from{id,username}',
          ...(input.limit === undefined ? {} : { limit: this.limit(input.limit) }),
          ...(input.after ? { after: this.cursor(input.after) } : {}),
        },
        comment,
      ).then((result) => ({
        comments: result.items.map((item) => ({
          id: item.id,
          text: item.text ?? '',
          timestamp: item.timestamp,
          username: item.username ?? item.from?.username ?? null,
          authorId: item.from?.id ?? null,
        })),
        nextCursor: result.nextCursor,
      })),
    );
  }

  private async assertMediaOwner(input: {
    accountId: string;
    mediaId: string;
    accessToken: string;
  }) {
    const body = await this.get(
      this.url(`/${this.id(input.mediaId)}`, { fields: 'id,owner{id}' }),
      input.accessToken,
    );
    const parsed = ownedMedia.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.id !== input.mediaId ||
      parsed.data.owner.id !== input.accountId
    )
      throw new InstagramUnifiedReadError('permission', 403);
  }

  private async list<T extends z.ZodType>(
    input: { accessToken: string },
    path: string,
    fields: Record<string, string>,
    schema: T,
  ): Promise<{ items: z.infer<T>[]; nextCursor: string | null }> {
    let nextAfter: string | undefined;
    const items: z.infer<T>[] = [];
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const requestFields = nextAfter ? { ...fields, after: nextAfter } : fields;
      const body = await this.get(this.url(path, requestFields), input.accessToken);
      const parsed = page(schema).safeParse(body);
      if (!parsed.success) throw new InstagramUnifiedReadError('permanent', 502);
      items.push(...parsed.data.data);
      nextAfter = parsed.data.paging?.next ? parsed.data.paging.cursors?.after : undefined;
      if (!nextAfter) break;
    }
    return { items, nextCursor: nextAfter ?? null };
  }

  private url(path: string, fields: Record<string, string>): URL {
    const url = new URL(`https://graph.facebook.com/${this.options.graphVersion}${path}`);
    for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, value);
    return url;
  }

  private async get(url: URL, accessToken: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(url, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        redirect: 'error',
      });
    } catch {
      throw new InstagramUnifiedReadError('transient', 0);
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) return body;
    const parsed = z
      .object({
        error: z
          .object({ code: z.number().optional(), error_subcode: z.number().optional() })
          .optional(),
      })
      .safeParse(body);
    const code = parsed.success ? parsed.data.error?.code : undefined;
    const kind =
      response.status === 401 || code === 190
        ? 'auth'
        : response.status === 403 || code === 10 || code === 200
          ? 'permission'
          : response.status === 429 || [4, 17, 32, 613].includes(code ?? -1)
            ? 'rate_limit'
            : response.status === 400
              ? 'validation'
              : response.status >= 500
                ? 'transient'
                : 'permanent';
    throw new InstagramUnifiedReadError(
      kind,
      response.status,
      code,
      parsed.success ? parsed.data.error?.error_subcode : undefined,
    );
  }

  private id(value: string): string {
    return graphId.parse(value);
  }
  private cursor(value: string): string {
    return z.string().min(1).max(2048).parse(value);
  }
  private limit(value: number): string {
    return String(z.number().int().min(1).max(100).parse(value));
  }
}
