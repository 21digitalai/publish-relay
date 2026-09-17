import { createHmac, randomBytes } from 'node:crypto';

import type { XApiError, XClient } from './x-adapter.js';
import type { XMediaUploadClient } from './x-media-staging.service.js';

export interface XUserCredential {
  accessToken: string;
  accessTokenSecret: string;
}

export interface XHttpClientOptions {
  consumerKey: string;
  consumerSecret: string;
  fetch?: typeof fetch;
  nonce?: () => string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  maxMediaStatusPolls?: number;
}

export interface XRequestToken {
  requestToken: string;
  requestTokenSecret: string;
  authorizationUrl: string;
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function parseCredential(value: string): XUserCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('X credential must be valid JSON');
  }
  const credential = parsed as Partial<XUserCredential>;
  if (!credential.accessToken || !credential.accessTokenSecret)
    throw new Error('X credential is missing OAuth 1.0a token material');
  return { accessToken: credential.accessToken, accessTokenSecret: credential.accessTokenSecret };
}

function retryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const reset = Number(response.headers.get('x-rate-limit-reset'));
  if (!Number.isFinite(reset)) return undefined;
  return Math.max(0, Math.ceil(reset - Date.now() / 1000));
}

async function toApiError(response: Response): Promise<XApiError> {
  const body = (await response.json().catch(() => null)) as {
    detail?: string;
    title?: string;
    errors?: { message?: string }[];
  } | null;
  const retryAfterSeconds = retryAfter(response);
  return {
    status: response.status,
    message: body?.detail ?? body?.errors?.[0]?.message ?? body?.title ?? 'X request failed',
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

interface XMediaResponse {
  media_id_string?: string;
  expires_after_secs?: number;
  processing_info?: {
    state?: 'pending' | 'in_progress' | 'succeeded' | 'failed';
    check_after_secs?: number;
  };
}

const X_MEDIA_UPLOAD_URL = 'https://upload.twitter.com/1.1/media/upload.json';
const DEFAULT_MEDIA_STATUS_POLLS = 4;
const MAX_STATUS_DELAY_MS = 30_000;

export class XHttpClient implements XClient, XMediaUploadClient {
  private readonly request: typeof fetch;
  private readonly nonce: () => string;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxMediaStatusPolls: number;

  public constructor(private readonly options: XHttpClientOptions) {
    if (!options.consumerKey || !options.consumerSecret)
      throw new Error('X consumer credentials are required');
    this.request = options.fetch ?? fetch;
    this.nonce = options.nonce ?? (() => randomBytes(18).toString('base64url'));
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.maxMediaStatusPolls = options.maxMediaStatusPolls ?? DEFAULT_MEDIA_STATUS_POLLS;
    if (!Number.isInteger(this.maxMediaStatusPolls) || this.maxMediaStatusPolls < 1)
      throw new Error('X media status poll limit must be a positive integer');
  }

  public connect(): Promise<{ credential: string }> {
    return Promise.reject(
      new Error('X OAuth 1.0a connection requires the request-token callback lifecycle'),
    );
  }

  public async beginConnection(callbackUrl: string): Promise<XRequestToken> {
    if (!callbackUrl) throw new Error('X OAuth callback URL is required');
    const body = await this.callOauthToken(
      'https://api.x.com/oauth/request_token',
      { oauth_callback: callbackUrl },
      '',
    );
    if (body.get('oauth_callback_confirmed') !== 'true')
      throw new Error('X did not confirm the OAuth callback');
    const requestToken = body.get('oauth_token');
    const requestTokenSecret = body.get('oauth_token_secret');
    if (!requestToken || !requestTokenSecret)
      throw new Error('X request-token response is incomplete');
    return {
      requestToken,
      requestTokenSecret,
      authorizationUrl: `https://api.x.com/oauth/authorize?oauth_token=${encodeURIComponent(requestToken)}`,
    };
  }

  public async completeConnection(
    requestToken: string,
    requestTokenSecret: string,
    verifier: string,
  ): Promise<{ credential: string }> {
    if (!requestToken || !requestTokenSecret || !verifier)
      throw new Error('X OAuth callback material is incomplete');
    const body = await this.callOauthToken(
      'https://api.x.com/oauth/access_token',
      { oauth_token: requestToken, oauth_verifier: verifier },
      requestTokenSecret,
    );
    const accessToken = body.get('oauth_token');
    const accessTokenSecret = body.get('oauth_token_secret');
    if (!accessToken || !accessTokenSecret)
      throw new Error('X access-token response is incomplete');
    return { credential: JSON.stringify({ accessToken, accessTokenSecret }) };
  }

  public async currentAccount(
    credentialValue: string,
  ): Promise<{ id: string; name: string; username: string }> {
    const body = await this.call<{ data: { id: string; name: string; username: string } }>(
      'GET',
      'https://api.x.com/2/users/me',
      credentialValue,
    );
    return body.data;
  }

  public async createPost(input: {
    text: string;
    mediaIds: string[];
    quoteTweetId?: string;
    idempotencyKey: string;
  }): Promise<{ id: string; username: string }> {
    void input.idempotencyKey;
    const credential = this.activeCredential;
    if (!credential) throw new Error('X credential must be bound before publishing');
    const payload = {
      text: input.text,
      ...(input.mediaIds.length === 0 ? {} : { media: { media_ids: input.mediaIds } }),
      ...(input.quoteTweetId ? { quote_tweet_id: input.quoteTweetId } : {}),
    };
    const created = await this.call<{ data: { id: string } }>(
      'POST',
      'https://api.x.com/2/tweets',
      credential,
      payload,
    );
    const account = await this.currentAccount(credential);
    return { id: created.data.id, username: account.username };
  }

  public async getPost(id: string): Promise<{ id: string; username: string } | null> {
    const credential = this.activeCredential;
    if (!credential) throw new Error('X credential must be bound before lookup');
    const response = await this.call<{
      data?: { id: string; author_id: string };
      includes?: { users?: { id: string; username: string }[] };
    }>(
      'GET',
      `https://api.x.com/2/tweets/${encodeURIComponent(id)}?expansions=author_id&user.fields=username`,
      credential,
      undefined,
      true,
    );
    if (!response.data) return null;
    const author = response.includes?.users?.find((user) => user.id === response.data?.author_id);
    if (!author) throw new Error('X lookup response omitted the post author');
    return { id: response.data.id, username: author.username };
  }

  public async deletePost(id: string): Promise<void> {
    if (!id) throw new Error('X post ID is required for deletion');
    const credential = this.activeCredential;
    if (!credential) throw new Error('X credential must be bound before deletion');
    await this.call<{ data: { deleted: boolean } }>(
      'DELETE',
      `https://api.x.com/2/tweets/${encodeURIComponent(id)}`,
      credential,
    );
  }

  public revoke(credentialValue: string): Promise<void> {
    parseCredential(credentialValue);
    return Promise.reject(new Error('X OAuth 1.0a revocation endpoint is not verified'));
  }

  private activeCredential: string | null = null;

  public bindCredential(credentialValue: string): this {
    parseCredential(credentialValue);
    this.activeCredential = credentialValue;
    return this;
  }

  public async init(input: {
    totalBytes: number;
    mimeType: string;
    idempotencyKey: string;
  }): Promise<{ mediaId: string; expiresAfterSeconds: number }> {
    void input.idempotencyKey;
    const response = await this.callMediaForm({
      command: 'INIT',
      total_bytes: String(input.totalBytes),
      media_type: input.mimeType,
      media_category: mediaCategory(input.mimeType),
    });
    if (!response.media_id_string || !response.expires_after_secs)
      throw new XRequestError(502, 'X media INIT response is incomplete');
    return {
      mediaId: response.media_id_string,
      expiresAfterSeconds: response.expires_after_secs,
    };
  }

  public async append(mediaId: string, segmentIndex: number, bytes: Buffer): Promise<void> {
    const credential = this.requireActiveCredential('uploading media');
    const authorization = this.authorization('POST', X_MEDIA_UPLOAD_URL, credential);
    const body = new FormData();
    body.set('command', 'APPEND');
    body.set('media_id', mediaId);
    body.set('segment_index', String(segmentIndex));
    body.set('media', new Blob([Uint8Array.from(bytes)]));
    await this.requestMedia(authorization, body, false);
  }

  public async finalize(mediaId: string): Promise<{ state: 'succeeded' | 'pending' | 'failed' }> {
    return mediaState(await this.callMediaForm({ command: 'FINALIZE', media_id: mediaId }));
  }

  public async status(
    mediaId: string,
  ): Promise<{ state: 'succeeded' | 'pending' | 'failed' | 'not_finalized' }> {
    for (let attempt = 0; attempt < this.maxMediaStatusPolls; attempt += 1) {
      let response: XMediaResponse;
      try {
        response = await this.callMediaGet(mediaId);
      } catch (error) {
        // X returns 404 for STATUS after INIT/APPEND but before FINALIZE. That is
        // lifecycle state, not a missing upload: the caller must FINALIZE next.
        if (error instanceof XRequestError && error.status === 404) {
          return { state: 'not_finalized' };
        }
        throw error;
      }
      if (!response.processing_info) return { state: 'not_finalized' };
      const state = mediaState(response);
      if (state.state !== 'pending' || attempt === this.maxMediaStatusPolls - 1) return state;
      const seconds = response.processing_info.check_after_secs ?? 0;
      await this.sleep(Math.min(seconds * 1000, MAX_STATUS_DELAY_MS));
    }
    return { state: 'pending' };
  }

  public discard(mediaId: string): Promise<void> {
    void mediaId;
    return Promise.resolve();
  }

  private requireActiveCredential(action: string): XUserCredential {
    if (!this.activeCredential) throw new Error(`X credential must be bound before ${action}`);
    return parseCredential(this.activeCredential);
  }

  private async callMediaForm(fields: Record<string, string>): Promise<XMediaResponse> {
    const credential = this.requireActiveCredential('uploading media');
    const authorization = this.authorization('POST', X_MEDIA_UPLOAD_URL, credential, {}, fields);
    return this.requestMedia(authorization, new URLSearchParams(fields), true);
  }

  private async callMediaGet(mediaId: string): Promise<XMediaResponse> {
    const credential = this.requireActiveCredential('checking media');
    const url = `${X_MEDIA_UPLOAD_URL}?command=STATUS&media_id=${encodeURIComponent(mediaId)}`;
    const authorization = this.authorization('GET', url, credential);
    return this.requestMediaGet(url, authorization);
  }

  private async requestMedia(
    authorization: string,
    body: FormData | URLSearchParams,
    expectsJson: boolean,
  ): Promise<XMediaResponse> {
    let response: Response;
    try {
      response = await this.request(X_MEDIA_UPLOAD_URL, {
        method: 'POST',
        headers: { authorization },
        body,
      });
    } catch (cause) {
      throw new XRequestError(503, 'X media upload request failed', { cause });
    }
    if (!response.ok) throw await mediaRequestError(response);
    return expectsJson ? ((await response.json()) as XMediaResponse) : {};
  }

  private async requestMediaGet(url: string, authorization: string): Promise<XMediaResponse> {
    let response: Response;
    try {
      response = await this.request(url, { method: 'GET', headers: { authorization } });
    } catch (cause) {
      throw new XRequestError(503, 'X media status request failed', { cause });
    }
    if (!response.ok) throw await mediaRequestError(response);
    return (await response.json()) as XMediaResponse;
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    credentialValue: string,
    body?: object,
    allowNotFound = false,
  ): Promise<T> {
    const credential = parseCredential(credentialValue);
    const authorization = this.authorization(method, url, credential);
    let response: Response;
    try {
      response = await this.request(url, {
        method,
        headers: { authorization, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      throw new XRequestError(503, 'X network request failed', {
        outcomeUnknown: method === 'POST',
        cause,
      });
    }
    if (allowNotFound && response.status === 404) return {} as T;
    if (!response.ok) {
      const error = await toApiError(response);
      throw new XRequestError(error.status, error.message, {
        ...(error.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: error.retryAfterSeconds }),
      });
    }
    return (await response.json()) as T;
  }

  private async callOauthToken(
    url: string,
    oauthParameters: Record<string, string>,
    tokenSecret: string,
  ): Promise<URLSearchParams> {
    const authorization = this.authorization(
      'POST',
      url,
      { accessToken: oauthParameters.oauth_token ?? '', accessTokenSecret: tokenSecret },
      oauthParameters,
    );
    let response: Response;
    try {
      response = await this.request(url, { method: 'POST', headers: { authorization } });
    } catch (cause) {
      throw new XRequestError(503, 'X OAuth request failed', { cause });
    }
    if (!response.ok) {
      const error = await toApiError(response);
      throw new XRequestError(error.status, error.message);
    }
    return new URLSearchParams(await response.text());
  }

  private authorization(
    method: string,
    urlValue: string,
    credential: XUserCredential,
    additionalOauth: Record<string, string> = {},
    signatureParameters: Record<string, string> = {},
  ): string {
    const url = new URL(urlValue);
    const oauth: Record<string, string> = {
      oauth_consumer_key: this.options.consumerKey,
      oauth_nonce: this.nonce(),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: Math.floor(this.now() / 1000).toString(),
      oauth_version: '1.0',
      ...(credential.accessToken ? { oauth_token: credential.accessToken } : {}),
      ...additionalOauth,
    };
    const parameters = [
      ...url.searchParams.entries(),
      ...Object.entries(oauth),
      ...Object.entries(signatureParameters),
    ]
      .map(([key, value]) => [encode(key), encode(value)] as const)
      .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey === rightKey
          ? leftValue.localeCompare(rightValue)
          : leftKey.localeCompare(rightKey),
      );
    const parameterString = parameters.map(([key, value]) => `${key}=${value}`).join('&');
    const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
    const signatureBase = [method, encode(baseUrl), encode(parameterString)].join('&');
    const signingKey = `${encode(this.options.consumerSecret)}&${encode(credential.accessTokenSecret)}`;
    oauth.oauth_signature = createHmac('sha1', signingKey).update(signatureBase).digest('base64');
    return `OAuth ${Object.entries(oauth)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${encode(key)}="${encode(value)}"`)
      .join(', ')}`;
  }
}

function mediaCategory(mimeType: string): string {
  if (mimeType === 'image/gif') return 'tweet_gif';
  if (mimeType.startsWith('video/')) return 'tweet_video';
  return 'tweet_image';
}

function mediaState(response: XMediaResponse): { state: 'succeeded' | 'pending' | 'failed' } {
  const state = response.processing_info?.state;
  if (!state || state === 'succeeded') return { state: 'succeeded' };
  if (state === 'failed') return { state: 'failed' };
  return { state: 'pending' };
}

async function mediaRequestError(response: Response): Promise<XRequestError> {
  const error = await toApiError(response);
  return new XRequestError(error.status, error.message, {
    ...(error.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: error.retryAfterSeconds }),
  });
}

class XRequestError extends Error implements XApiError {
  public readonly retryAfterSeconds?: number;
  public readonly outcomeUnknown?: boolean;

  public constructor(
    public readonly status: number,
    message: string,
    options: { retryAfterSeconds?: number; outcomeUnknown?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
    if (options.outcomeUnknown !== undefined) this.outcomeUnknown = options.outcomeUnknown;
  }
}
