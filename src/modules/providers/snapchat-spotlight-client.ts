import { z } from 'zod';

const ORIGIN = 'https://businessapi.snapchat.com';
const TIMEOUT_MS = 15_000;
const mediaResponse = z.object({
  request_status: z.literal('SUCCESS'),
  media_id: z.uuid(),
  add_path: z.string().min(1),
  finalize_path: z.string().min(1),
});
const successResponse = z.object({ request_status: z.literal('SUCCESS') });
const postedResponse = successResponse.extend({ spotlight_id: z.string().min(1) });
const spotlightResponse = successResponse.extend({
  spotlights: z
    .array(
      z.object({
        sub_request_status: z.literal('SUCCESS'),
        spotlight: z.object({
          id: z.string().min(1),
          profile_id: z.uuid(),
          status: z.enum(['SUBMITTED', 'LIVE', 'REJECTED']),
        }),
      }),
    )
    .length(1),
});

export class SnapchatSpotlightRequestError extends Error {
  public constructor(
    public readonly kind:
      'auth' | 'rate_limit' | 'validation' | 'transient' | 'permanent' | 'unknown',
    public readonly retryAfterSeconds?: number,
  ) {
    super(`Snapchat Spotlight request failed: ${kind}`);
  }
}

function classify(status: number, response: Response): SnapchatSpotlightRequestError {
  const retry = Number(response.headers.get('retry-after'));
  if (status === 401 || status === 403) return new SnapchatSpotlightRequestError('auth');
  if (status === 429)
    return new SnapchatSpotlightRequestError(
      'rate_limit',
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
    );
  if (status >= 500) return new SnapchatSpotlightRequestError('transient');
  if (status === 400 || status === 422) return new SnapchatSpotlightRequestError('validation');
  return new SnapchatSpotlightRequestError('permanent');
}

function uploadPath(profileId: string, mediaId: string, raw: string): string {
  const expected = `/us/v1/public_profiles/${profileId}/media/${mediaId}/multipart-upload`;
  if (raw !== expected) throw new SnapchatSpotlightRequestError('permanent');
  return `${ORIGIN}${raw}`;
}

export class SnapchatSpotlightClient {
  protected readonly request: typeof fetch;

  public constructor(fetcher: typeof fetch = fetch) {
    this.request = fetcher;
  }

  protected async send(url: string, accessToken: string, init: RequestInit) {
    let response: Response;
    try {
      response = await this.request(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${accessToken}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new SnapchatSpotlightRequestError('unknown');
    }
    if (!response.ok) {
      // Snap may report this after a prior POST already entered processing. The
      // HTTP 4xx alone is not proof that publication did not happen.
      if (response.status === 400 || response.status === 409) {
        try {
          const body = (await response.clone().json()) as { error_code?: unknown };
          if (body.error_code === 'MEDIA_POSTING_ALREADY_IN_PROGRESS')
            throw new SnapchatSpotlightRequestError('unknown');
        } catch (error) {
          if (error instanceof SnapchatSpotlightRequestError) throw error;
        }
      }
      throw classify(response.status, response);
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new SnapchatSpotlightRequestError('unknown');
    }
  }

  public async createMedia(input: {
    profileId: string;
    accessToken: string;
    name: string;
    key: Buffer;
    iv: Buffer;
    mediaType?: 'VIDEO' | 'IMAGE';
  }): Promise<{ mediaId: string; addUrl: string; finalizeUrl: string }> {
    const body = await this.send(
      `${ORIGIN}/v1/public_profiles/${input.profileId}/media`,
      input.accessToken,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: input.mediaType ?? 'VIDEO',
          name: input.name,
          key: input.key.toString('base64'),
          iv: input.iv.toString('base64'),
        }),
      },
    );
    const parsed = mediaResponse.safeParse(body);
    if (!parsed.success) throw new SnapchatSpotlightRequestError('unknown');
    return {
      mediaId: parsed.data.media_id,
      addUrl: uploadPath(input.profileId, parsed.data.media_id, parsed.data.add_path),
      finalizeUrl: uploadPath(input.profileId, parsed.data.media_id, parsed.data.finalize_path),
    };
  }

  public async addChunk(url: string, accessToken: string, bytes: Buffer, partNumber: number) {
    const form = new FormData();
    form.set('action', 'ADD');
    form.set('part_number', String(partNumber));
    form.set('file', new Blob([new Uint8Array(bytes)]), `part-${String(partNumber)}`);
    const parsed = successResponse.safeParse(
      await this.send(url, accessToken, { method: 'POST', body: form }),
    );
    if (!parsed.success) throw new SnapchatSpotlightRequestError('unknown');
  }

  public async finalize(url: string, accessToken: string) {
    const form = new FormData();
    form.set('action', 'FINALIZE');
    const parsed = successResponse.safeParse(
      await this.send(url, accessToken, { method: 'POST', body: form }),
    );
    if (!parsed.success) throw new SnapchatSpotlightRequestError('unknown');
  }

  public async post(input: {
    profileId: string;
    accessToken: string;
    mediaId: string;
    locale: string;
    description?: string;
  }): Promise<string> {
    // A timeout, 5xx, or malformed success after this POST may have published.
    let body: unknown;
    try {
      body = await this.send(
        `${ORIGIN}/v1/public_profiles/${input.profileId}/spotlights`,
        input.accessToken,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            media_id: input.mediaId,
            locale: input.locale,
            ...(input.description === undefined ? {} : { description: input.description }),
          }),
        },
      );
    } catch (error) {
      if (
        error instanceof SnapchatSpotlightRequestError &&
        ['auth', 'rate_limit', 'validation', 'permanent'].includes(error.kind)
      )
        throw error;
      throw new SnapchatSpotlightRequestError('unknown');
    }
    const parsed = postedResponse.safeParse(body);
    if (!parsed.success) throw new SnapchatSpotlightRequestError('unknown');
    return parsed.data.spotlight_id;
  }

  public async lookup(input: { profileId: string; spotlightId: string; accessToken: string }) {
    const body = await this.send(
      `${ORIGIN}/v1/public_profiles/${input.profileId}/spotlights/${encodeURIComponent(input.spotlightId)}`,
      input.accessToken,
      { method: 'GET' },
    );
    const parsed = spotlightResponse.safeParse(body);
    const spotlight = parsed.success ? parsed.data.spotlights[0]?.spotlight : undefined;
    if (spotlight?.id !== input.spotlightId || spotlight.profile_id !== input.profileId)
      throw new SnapchatSpotlightRequestError('unknown');
    return spotlight.status;
  }
}
