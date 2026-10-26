import { z } from 'zod';

import { FanvueRequestError } from './fanvue-http-client.js';

const result = z.object({
  uuid: z.uuid(),
  text: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime().nullable(),
});

export class FanvueCommentOutcomeUnknownError extends Error {
  constructor() {
    super('Fanvue comment outcome is unknown; reconcile before any resend');
  }
}

/** Creates a top-level comment only; the documented API has no reply/parent field. */
export class FanvueCommentClient {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async createComment(accessToken: string, postUuid: string, text: string) {
    if (!accessToken) throw new Error('Fanvue access token is required');
    const id = z.uuid().parse(postUuid);
    const body = { text: z.string().min(1).max(600).parse(text) };
    let response: Response;
    try {
      response = await this.request(`https://api.fanvue.com/v1/posts/${id}/comments`, {
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
      throw new FanvueCommentOutcomeUnknownError();
    }
    if (response.status >= 500) throw new FanvueCommentOutcomeUnknownError();
    if (!response.ok) throw new FanvueRequestError(response.status);
    if (response.status !== 201) throw new FanvueCommentOutcomeUnknownError();
    try {
      const parsed = result.safeParse(await response.json());
      if (!parsed.success) throw new Error('Invalid Fanvue comment response');
      return parsed.data;
    } catch {
      throw new FanvueCommentOutcomeUnknownError();
    }
  }
}
