import { z } from 'zod';

import { FanvueRequestError } from './fanvue-http-client.js';

const session = z.object({
  mediaUuid: z.uuid(),
  uploadId: z.string().min(1),
  partSize: z.number().int().positive(),
  maxParts: z.number().int().positive(),
  totalParts: z.number().int().positive().nullable(),
});
const signedParts = z.object({
  partSize: z.number().int().positive(),
  parts: z
    .array(z.object({ partNumber: z.number().int().positive(), url: z.url() }))
    .min(1)
    .max(256),
});
const mediaStatus = z.object({
  uuid: z.uuid(),
  status: z.enum(['created', 'processing', 'ready', 'error']),
  errorReason: z.string().nullish(),
});

export class FanvueMediaUploadClient {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  createSession(
    accessToken: string,
    input: {
      name: string;
      filename: string;
      mediaType: 'image' | 'video' | 'audio' | 'document';
      sizeBytes: number;
    },
  ) {
    const body = z
      .strictObject({
        name: z.string().min(1),
        filename: z.string().min(1),
        mediaType: z.enum(['image', 'video', 'audio', 'document']),
        sizeBytes: z.number().int().positive().max(1_610_612_736),
      })
      .parse(input);
    if (body.mediaType === 'document' && body.sizeBytes > 104_857_600)
      throw new Error('Fanvue document exceeds the provider size limit');
    return this.api(
      accessToken,
      '/media/uploads',
      { method: 'POST', body: JSON.stringify(body) },
      session,
    );
  }

  async signParts(accessToken: string, uploadId: string, from: number, to: number) {
    const id = encodeURIComponent(z.string().min(1).max(512).parse(uploadId));
    const start = z.number().int().positive().parse(from);
    const end = z.number().int().min(start).max(256).parse(to);
    const result = await this.api(
      accessToken,
      `/media/uploads/${id}/parts/urls?from=${String(start)}&to=${String(end)}`,
      {},
      signedParts,
    );
    const numbers = result.parts.map((part) => part.partNumber);
    if (
      numbers.length !== end - start + 1 ||
      new Set(numbers).size !== numbers.length ||
      numbers.some((number) => number < start || number > end)
    )
      throw new FanvueRequestError(502, 'invalid_response');
    return result;
  }

  async putPart(url: string, bytes: Buffer): Promise<string> {
    const destination = new URL(url);
    if (destination.protocol !== 'https:' || destination.username || destination.password)
      throw new Error('Invalid Fanvue signed part URL');
    let response: Response;
    try {
      response = await this.request(destination, {
        method: 'PUT',
        body: Uint8Array.from(bytes),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new FanvueRequestError(502, 'transport_failure');
    }
    if (!response.ok) throw new FanvueRequestError(response.status);
    const etag = response.headers.get('etag');
    if (!etag) throw new FanvueRequestError(502, 'invalid_response');
    return etag;
  }

  completeSession(
    accessToken: string,
    uploadId: string,
    parts: { PartNumber: number; ETag: string }[],
  ) {
    const id = encodeURIComponent(z.string().min(1).max(512).parse(uploadId));
    const body = z
      .object({
        parts: z
          .array(z.object({ PartNumber: z.number().int().positive(), ETag: z.string().min(1) }))
          .min(1)
          .max(256),
      })
      .parse({ parts });
    return this.api(
      accessToken,
      `/media/uploads/${id}`,
      { method: 'PATCH', body: JSON.stringify(body) },
      z.object({ status: z.string() }),
    );
  }

  getStatus(accessToken: string, mediaUuid: string) {
    const id = z.uuid().parse(mediaUuid);
    return this.api(accessToken, `/media/${id}`, {}, mediaStatus);
  }

  private async api<T extends z.ZodType>(
    accessToken: string,
    path: string,
    options: RequestInit,
    schema: T,
  ): Promise<z.infer<T>> {
    if (!accessToken) throw new Error('Fanvue access token is required');
    let response: Response;
    try {
      response = await this.request(`https://api.fanvue.com${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Fanvue-API-Version': '2025-06-26',
          'Content-Type': 'application/json',
        },
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
