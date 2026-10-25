import { z } from 'zod';

import { FanvueRequestError } from './fanvue-http-client.js';

const postInput = z.strictObject({
  audience: z.enum(['subscribers', 'followers-and-subscribers']),
  text: z.string().max(5000).optional(),
  mediaUuids: z.array(z.uuid()).optional(),
  mediaPreviewUuid: z.uuid().optional(),
  price: z.number().int().min(300).optional(),
});
const postResult = z.object({
  uuid: z.uuid(),
  createdAt: z.iso.datetime(),
  publishedAt: z.iso.datetime().nullish(),
});

export type FanvuePostInput = z.infer<typeof postInput>;

export class FanvuePostOutcomeUnknownError extends Error {
  constructor() {
    super('Fanvue post outcome is unknown; reconcile before any resend');
  }
}

/** Provider transport. Caller must reserve durable attempt intent and prove account/media reach first. */
export class FanvuePostClient {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async createPost(accessToken: string, input: FanvuePostInput) {
    if (!accessToken) throw new Error('Fanvue access token is required');
    const body = postInput.parse(input);
    if (!body.text && !body.mediaUuids?.length)
      throw new Error('Fanvue post requires text or media');
    if (body.price !== undefined && !body.mediaUuids?.length)
      throw new Error('Fanvue paid post requires media');
    if (body.mediaPreviewUuid && !body.mediaUuids?.includes(body.mediaPreviewUuid))
      throw new Error('Fanvue preview must be attached media');
    let response: Response;
    try {
      response = await this.request('https://api.fanvue.com/v1/posts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Fanvue-API-Version': '2025-06-26',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new FanvuePostOutcomeUnknownError();
    }
    if (response.status >= 500) throw new FanvuePostOutcomeUnknownError();
    if (!response.ok) throw new FanvueRequestError(response.status);
    try {
      const parsed = postResult.safeParse(await response.json());
      if (!parsed.success) throw new Error('Invalid Fanvue post response');
      return parsed.data;
    } catch {
      throw new FanvuePostOutcomeUnknownError();
    }
  }
}
