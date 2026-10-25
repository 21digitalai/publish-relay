import { z } from 'zod';

import { FanvueRequestError } from './fanvue-http-client.js';

const person = z.object({ uuid: z.uuid(), handle: z.string().nullish() });
const message = z.object({
  uuid: z.uuid(),
  text: z.string().max(5000).nullish(),
  sentAt: z.string(),
  sender: person,
  recipient: person,
  type: z.string(),
  mediaUuids: z.array(z.uuid()).max(50).optional(),
  mediaPreviewUuid: z.uuid().nullish(),
  pricing: z.object({ USD: z.object({ price: z.number().int().nonnegative() }) }).nullish(),
  purchasedAt: z.string().nullish(),
  tipSource: z.string().nullish(),
  isRead: z.boolean().optional(),
});
const chat = z.object({
  user: person.extend({ displayName: z.string().nullish() }),
  isRead: z.boolean(),
  unreadMessagesCount: z.number().int().nonnegative(),
  lastMessage: message.partial().nullable().optional(),
});
const media = z.object({
  uuid: z.uuid(),
  status: z.enum(['created', 'processing', 'ready', 'error']),
  errorReason: z.string().nullish(),
});
const postSummary = z
  .object({
    uuid: z.uuid(),
    createdAt: z.string(),
    publishedAt: z.string().nullish(),
    text: z.string().max(10_000).nullish(),
    audience: z.enum(['subscribers', 'followers-and-subscribers']),
    price: z.number().nonnegative().nullish(),
    mediaUuids: z.array(z.uuid()).max(50),
    commentsCount: z.number().int().nonnegative(),
  })
  .transform(({ text, ...post }) => ({ ...post, textPreview: text?.slice(0, 280) ?? null }));
const postDetail = z.object({
  uuid: z.uuid(),
  createdAt: z.string(),
  publishedAt: z.string().nullish(),
  text: z.string().max(10_000).nullish(),
  audience: z.enum(['subscribers', 'followers-and-subscribers']),
  price: z.number().nonnegative().nullish(),
  mediaUuids: z.array(z.uuid()).max(50),
  mediaPreviewUuid: z.uuid().nullish(),
});
const comment = z.object({
  uuid: z.uuid(),
  text: z.string().max(5000),
  createdAt: z.string(),
  updatedAt: z.string().nullish(),
  user: z.object({ uuid: z.uuid(), handle: z.string(), displayName: z.string() }).nullable(),
});
const offsetPagination = z.object({
  page: z.number().int().positive(),
  size: z.number().int().nonnegative().max(50),
  hasMore: z.boolean(),
});

function page(value: number, name: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new Error(`Invalid Fanvue ${name}`);
  return value;
}

/** Provider transport only. The caller must enforce workspace, account and read-scope reach. */
export class FanvueReadClient {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  listChats(
    accessToken: string,
    options: { page?: number; size?: number; unreadOnly?: boolean } = {},
  ) {
    const query = new URLSearchParams({
      page: String(page(options.page ?? 1, 'page', Number.MAX_SAFE_INTEGER)),
      size: String(page(options.size ?? 15, 'size', 50)),
    });
    if (options.unreadOnly) query.set('filter', 'unread');
    return this.get(
      accessToken,
      `/chats?${query}`,
      z.object({ data: z.array(chat).max(50), pagination: offsetPagination }),
    );
  }

  listMessages(
    accessToken: string,
    fanUuid: string,
    options: { page?: number; size?: number } = {},
  ) {
    const id = z.uuid().parse(fanUuid);
    const query = new URLSearchParams({
      page: String(page(options.page ?? 1, 'page', Number.MAX_SAFE_INTEGER)),
      size: String(page(options.size ?? 15, 'size', 50)),
      markAsRead: 'false',
    });
    return this.get(
      accessToken,
      `/chats/${id}/messages?${query}`,
      z.object({ data: z.array(message).max(50), pagination: offsetPagination }),
    );
  }

  listMedia(accessToken: string, options: { page?: number; size?: number } = {}) {
    const query = new URLSearchParams({
      page: String(page(options.page ?? 1, 'page', Number.MAX_SAFE_INTEGER)),
      size: String(page(options.size ?? 15, 'size', 50)),
    });
    return this.get(
      accessToken,
      `/media?${query}`,
      z.object({ data: z.array(media).max(50), pagination: offsetPagination }),
    );
  }

  getMediaStatus(accessToken: string, mediaUuid: string) {
    const id = z.uuid().parse(mediaUuid);
    return this.get(accessToken, `/media/${id}`, media);
  }

  listPosts(accessToken: string, options: { cursor?: string; size?: number } = {}) {
    const query = new URLSearchParams({ size: String(page(options.size ?? 15, 'size', 50)) });
    if (options.cursor) query.set('cursor', z.string().min(1).max(1024).parse(options.cursor));
    return this.get(
      accessToken,
      `/v1/posts?${query}`,
      z.object({
        data: z.array(postSummary).max(50),
        nextCursor: z.string().max(1024).nullable(),
      }),
    );
  }

  getPost(accessToken: string, postUuid: string) {
    const id = z.uuid().parse(postUuid);
    return this.get(accessToken, `/v1/posts/${id}`, postDetail);
  }

  listComments(
    accessToken: string,
    postUuid: string,
    options: { cursor?: string; size?: number } = {},
  ) {
    const id = z.uuid().parse(postUuid);
    const query = new URLSearchParams({ size: String(page(options.size ?? 15, 'size', 50)) });
    if (options.cursor) query.set('cursor', z.string().min(1).max(1024).parse(options.cursor));
    return this.get(
      accessToken,
      `/v1/posts/${id}/comments?${query}`,
      z.object({
        data: z.array(comment).max(50),
        nextCursor: z.string().max(1024).nullable(),
      }),
    );
  }

  private async get<T extends z.ZodType>(
    accessToken: string,
    path: string,
    schema: T,
  ): Promise<z.infer<T>> {
    if (!accessToken) throw new Error('Fanvue access token is required');
    let response: Response;
    try {
      response = await this.request(`https://api.fanvue.com${path}`, {
        headers: { Authorization: `Bearer ${accessToken}`, 'X-Fanvue-API-Version': '2025-06-26' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new FanvueRequestError(502, 'transport_failure');
    }
    if (!response.ok) throw new FanvueRequestError(response.status);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new FanvueRequestError(502, 'invalid_response');
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new FanvueRequestError(response.status, 'invalid_response');
    return parsed.data;
  }
}
