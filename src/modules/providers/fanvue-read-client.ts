import { z } from 'zod';

import { FanvueRequestError } from './fanvue-http-client.js';

const person = z.object({ uuid: z.uuid(), handle: z.string().nullish() });
const message = z.object({
  uuid: z.uuid(),
  text: z.string().nullish(),
  sentAt: z.string(),
  sender: person,
  recipient: person,
  type: z.string(),
  mediaUuids: z.array(z.uuid()).optional(),
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
    return this.get(accessToken, `/chats?${query}`, z.object({ data: z.array(chat) }));
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
      z.object({ data: z.array(message) }),
    );
  }

  listMedia(accessToken: string, options: { page?: number; size?: number } = {}) {
    const query = new URLSearchParams({
      page: String(page(options.page ?? 1, 'page', Number.MAX_SAFE_INTEGER)),
      size: String(page(options.size ?? 15, 'size', 50)),
    });
    return this.get(accessToken, `/media?${query}`, z.object({ data: z.array(media) }));
  }

  getMediaStatus(accessToken: string, mediaUuid: string) {
    const id = z.uuid().parse(mediaUuid);
    return this.get(accessToken, `/media/${id}`, media);
  }

  private async get<T extends z.ZodType>(
    accessToken: string,
    path: string,
    schema: T,
  ): Promise<z.infer<T>> {
    if (!accessToken) throw new Error('Fanvue access token is required');
    const response = await this.request(`https://api.fanvue.com${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'X-Fanvue-API-Version': '2025-06-26' },
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new FanvueRequestError(response.status);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new FanvueRequestError(response.status, 'invalid_response');
    return parsed.data;
  }
}
