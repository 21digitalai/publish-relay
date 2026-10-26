import { z } from 'zod';

import { FanvueRequestError } from './fanvue-http-client.js';

const createResult = z.strictObject({
  id: z.uuid(),
  signingSecret: z.string().regex(/^whsec_[a-f0-9]{64}$/),
});
const listItem = z.object({
  id: z.uuid(),
  url: z.url().startsWith('https://'),
  events: z.array(z.string()),
  createdAt: z.iso.datetime(),
});
const listResult = z.union([
  z.array(listItem).max(20),
  z.object({ data: z.array(listItem).max(20) }),
  z.object({ subscriptions: z.array(listItem).max(20) }),
]);

export class FanvueSubscriptionOutcomeUnknownError extends Error {
  constructor() {
    super('Fanvue subscription outcome is unknown; reconcile before another mutation');
  }
}

/** Transport only: caller owns selected-account consent and durable intent. */
export class FanvuePaymentSubscriptionClient {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async list(accessToken: string) {
    if (!accessToken) throw new Error('Fanvue access token is required');
    let response: Response;
    try {
      response = await this.request('https://api.fanvue.com/webhooks/subscriptions', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Fanvue-API-Version': '2025-06-26',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new FanvueSubscriptionOutcomeUnknownError();
    }
    if (response.status >= 500) throw new FanvueSubscriptionOutcomeUnknownError();
    if (!response.ok) throw new FanvueRequestError(response.status);
    if (response.status !== 200) throw new FanvueSubscriptionOutcomeUnknownError();
    try {
      const result = listResult.parse(await response.json());
      if (Array.isArray(result)) return result;
      return 'data' in result ? result.data : result.subscriptions;
    } catch {
      throw new FanvueSubscriptionOutcomeUnknownError();
    }
  }

  async create(accessToken: string, callbackUrl: string) {
    if (!accessToken) throw new Error('Fanvue access token is required');
    const url = z.url().startsWith('https://').parse(callbackUrl);
    let response: Response;
    try {
      response = await this.request('https://api.fanvue.com/webhooks/subscriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Fanvue-API-Version': '2025-06-26',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url, events: ['creator.payment.succeeded'] }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new FanvueSubscriptionOutcomeUnknownError();
    }
    if (response.status >= 500) throw new FanvueSubscriptionOutcomeUnknownError();
    if (!response.ok) throw new FanvueRequestError(response.status);
    if (response.status !== 201) throw new FanvueSubscriptionOutcomeUnknownError();
    try {
      return createResult.parse(await response.json());
    } catch {
      throw new FanvueSubscriptionOutcomeUnknownError();
    }
  }

  async delete(accessToken: string, providerSubscriptionId: string): Promise<void> {
    if (!accessToken) throw new Error('Fanvue access token is required');
    const id = z.uuid().parse(providerSubscriptionId);
    let response: Response;
    try {
      response = await this.request(
        `https://api.fanvue.com/webhooks/subscriptions/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-Fanvue-API-Version': '2025-06-26',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      throw new FanvueSubscriptionOutcomeUnknownError();
    }
    if (response.status === 404 || response.status === 204 || response.status === 200) return;
    if (response.status >= 500 || response.ok) throw new FanvueSubscriptionOutcomeUnknownError();
    throw new FanvueRequestError(response.status);
  }
}
