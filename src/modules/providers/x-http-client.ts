import { createHmac, randomBytes } from 'node:crypto';

import type { XApiError, XClient } from './x-adapter.js';

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

export class XHttpClient implements XClient {
  private readonly request: typeof fetch;
  private readonly nonce: () => string;
  private readonly now: () => number;

  public constructor(private readonly options: XHttpClientOptions) {
    if (!options.consumerKey || !options.consumerSecret)
      throw new Error('X consumer credentials are required');
    this.request = options.fetch ?? fetch;
    this.nonce = options.nonce ?? (() => randomBytes(18).toString('base64url'));
    this.now = options.now ?? Date.now;
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

  private async call<T>(
    method: 'GET' | 'POST',
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
    const parameters = [...url.searchParams.entries(), ...Object.entries(oauth)]
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
