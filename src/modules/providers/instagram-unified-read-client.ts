import { z } from 'zod';

const graphId = z.string().min(1).max(256);
const timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));
const page = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item).max(100),
    paging: z.object({ next: z.url().optional() }).optional(),
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
    let next: string | undefined = this.url(path, fields).toString();
    const items: z.infer<T>[] = [];
    for (let pageNumber = 0; next && pageNumber < MAX_PAGES; pageNumber += 1) {
      const body = await this.get(new URL(next), input.accessToken);
      const parsed = page(schema).safeParse(body);
      if (!parsed.success) throw new InstagramUnifiedReadError('permanent', 502);
      items.push(...parsed.data.data);
      next = parsed.data.paging?.next;
    }
    return { items, nextCursor: next ?? null };
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
