import type { EmailDelivery } from './magic-link.service.js';

interface ResendResponse {
  id?: string;
}

export class ResendEmailDelivery implements EmailDelivery {
  constructor(
    private readonly config: { apiKey: string; from: string; timeoutMs?: number },
    private readonly request: typeof fetch = fetch,
  ) {
    if (!config.apiKey || !config.from) throw new Error('Resend email configuration is required');
  }

  async sendMagicLink(input: {
    challengeId?: string;
    recipient: string;
    url: string;
    correlationId: string;
  }): Promise<{ messageId: string }> {
    const response = await this.request('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': input.correlationId,
      },
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
      body: JSON.stringify({
        from: this.config.from,
        to: [input.recipient],
        subject: 'Sign in to Publish Relay',
        text: `Use this one-time link to sign in to Publish Relay. It expires in 15 minutes:\n\n${input.url}\n\nIf you did not request this link, you can ignore this email.`,
      }),
    });
    if (!response.ok)
      throw new Error(`Resend delivery failed with status ${String(response.status)}`);
    const result = (await response.json()) as ResendResponse;
    if (!result.id) throw new Error('Resend delivery returned no message identifier');
    return { messageId: result.id };
  }
}
