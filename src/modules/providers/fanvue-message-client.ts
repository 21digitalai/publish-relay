import { z } from 'zod';

import { FanvueRequestError } from './fanvue-http-client.js';

const messageInput = z.strictObject({
  text: z.string().min(1).max(5000).optional(),
  mediaUuids: z.array(z.uuid()).min(1).optional(),
  mediaPreviewUuid: z.uuid().optional(),
  price: z.number().int().min(300).optional(),
});
const messageResult = z.object({ messageUuid: z.uuid() });

export type FanvueMessageInput = z.infer<typeof messageInput>;

export class FanvueMessageOutcomeUnknownError extends Error {
  constructor() {
    super('Fanvue message outcome is unknown; reconcile before any resend');
  }
}

/** Provider transport only. Caller must durably reserve intent and prove account/media reach. */
export class FanvueMessageClient {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async sendMessage(accessToken: string, fanUuid: string, input: FanvueMessageInput) {
    if (!accessToken) throw new Error('Fanvue access token is required');
    const id = z.uuid().parse(fanUuid);
    const body = messageInput.parse(input);
    if (!body.text && !body.mediaUuids?.length)
      throw new Error('Fanvue message requires text or media');
    if (body.price !== undefined && !body.mediaUuids?.length)
      throw new Error('Fanvue priced message requires media');
    if (body.mediaPreviewUuid && body.price === undefined)
      throw new Error('Fanvue preview requires a price');
    if (body.mediaPreviewUuid && !body.mediaUuids?.includes(body.mediaPreviewUuid))
      throw new Error('Fanvue preview must be attached media');

    let response: Response;
    try {
      response = await this.request(`https://api.fanvue.com/chats/${id}/message`, {
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
      throw new FanvueMessageOutcomeUnknownError();
    }
    if (response.status >= 500) throw new FanvueMessageOutcomeUnknownError();
    if (!response.ok) throw new FanvueRequestError(response.status);
    if (response.status !== 201) throw new FanvueMessageOutcomeUnknownError();
    try {
      const parsed = messageResult.safeParse(await response.json());
      if (!parsed.success) throw new Error('Invalid Fanvue message response');
      return parsed.data;
    } catch {
      throw new FanvueMessageOutcomeUnknownError();
    }
  }
}
