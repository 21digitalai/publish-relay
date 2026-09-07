import { z } from 'zod';

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

const channelResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      snippet: z.object({ title: z.string().min(1) }),
    }),
  ),
});

export interface YouTubeCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope?: string;
}

export interface YouTubeHttpClientOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export type YouTubeUploadProgress =
  { status: 'incomplete'; nextOffset: number } | { status: 'complete'; videoId: string };

export class YouTubeHttpClient {
  private readonly request: typeof fetch;
  private readonly now: () => number;

  public constructor(private readonly options: YouTubeHttpClientOptions) {
    if (!options.clientId || !options.clientSecret)
      throw new Error('Google OAuth credentials are required');
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  public async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<YouTubeCredential> {
    const token = await this.tokenRequest({
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    });
    if (!token.refresh_token) throw new Error('Google OAuth response omitted the refresh token');
    return this.credential(token, token.refresh_token);
  }

  public async refresh(credential: YouTubeCredential): Promise<YouTubeCredential> {
    const token = await this.tokenRequest({
      refresh_token: credential.refreshToken,
      grant_type: 'refresh_token',
    });
    return this.credential(token, token.refresh_token ?? credential.refreshToken);
  }

  public async discoverChannels(
    accessToken: string,
  ): Promise<{ id: string; displayName: string }[]> {
    const response = await this.request(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50',
      { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } },
    );
    const body = await this.responseJson(response, 'YouTube channel discovery');
    return channelResponseSchema.parse(body).items.map((item) => ({
      id: item.id,
      displayName: item.snippet.title,
    }));
  }

  public async revoke(token: string): Promise<void> {
    const response = await this.request('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    if (!response.ok)
      throw new Error(`Google token revocation failed with HTTP ${String(response.status)}`);
  }

  public async initiateUpload(input: {
    accessToken: string;
    totalBytes: number;
    mimeType: string;
    metadata: Record<string, unknown>;
    notifySubscribers: boolean;
  }): Promise<string> {
    const url = new URL('https://www.googleapis.com/upload/youtube/v3/videos');
    url.searchParams.set('uploadType', 'resumable');
    url.searchParams.set('part', 'snippet,status');
    url.searchParams.set('notifySubscribers', String(input.notifySubscribers));
    const response = await this.request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
        'x-upload-content-length': String(input.totalBytes),
        'x-upload-content-type': input.mimeType,
      },
      body: JSON.stringify(input.metadata),
    });
    if (!response.ok)
      throw new Error(`YouTube upload initialization failed with HTTP ${String(response.status)}`);
    const sessionUrl = response.headers.get('location');
    if (!sessionUrl) throw new Error('YouTube upload initialization omitted the session URL');
    return sessionUrl;
  }

  public queryUpload(
    sessionUrl: string,
    accessToken: string,
    totalBytes: number,
  ): Promise<YouTubeUploadProgress> {
    return this.uploadRequest(sessionUrl, accessToken, {
      headers: { 'content-length': '0', 'content-range': `bytes */${String(totalBytes)}` },
    });
  }

  public uploadChunk(input: {
    sessionUrl: string;
    accessToken: string;
    bytes: Uint8Array;
    startOffset: number;
    totalBytes: number;
  }): Promise<YouTubeUploadProgress> {
    const endOffset = input.startOffset + input.bytes.byteLength - 1;
    return this.uploadRequest(input.sessionUrl, input.accessToken, {
      headers: {
        'content-length': String(input.bytes.byteLength),
        'content-range': `bytes ${String(input.startOffset)}-${String(endOffset)}/${String(input.totalBytes)}`,
      },
      body: new Blob([Uint8Array.from(input.bytes)]),
    });
  }

  private async tokenRequest(fields: Record<string, string>) {
    const response = await this.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        ...fields,
      }),
    });
    return tokenResponseSchema.parse(await this.responseJson(response, 'Google token exchange'));
  }

  private async responseJson(response: Response, action: string): Promise<unknown> {
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw new Error(`${action} failed with HTTP ${String(response.status)}`);
    return body;
  }

  private async uploadRequest(
    sessionUrl: string,
    accessToken: string,
    init: { headers: Record<string, string>; body?: BodyInit },
  ): Promise<YouTubeUploadProgress> {
    const response = await this.request(sessionUrl, {
      method: 'PUT',
      headers: { authorization: `Bearer ${accessToken}`, ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    if (response.status === 308) {
      const range = response.headers.get('range');
      const match = range?.match(/^bytes=0-(\d+)$/);
      return { status: 'incomplete', nextOffset: match ? Number(match[1]) + 1 : 0 };
    }
    const body = (await this.responseJson(response, 'YouTube resumable upload')) as {
      id?: unknown;
    };
    if (typeof body.id !== 'string' || !body.id)
      throw new Error('YouTube upload response omitted video ID');
    return { status: 'complete', videoId: body.id };
  }

  private credential(
    token: z.infer<typeof tokenResponseSchema>,
    refreshToken: string,
  ): YouTubeCredential {
    return {
      accessToken: token.access_token,
      refreshToken,
      expiresAt: new Date(this.now() + token.expires_in * 1000).toISOString(),
      ...(token.scope ? { scope: token.scope } : {}),
    };
  }
}
