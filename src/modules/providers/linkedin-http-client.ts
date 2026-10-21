import { z } from 'zod';

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
});
const profileSchema = z.object({ sub: z.string().min(1), name: z.string().optional() });
const LINKEDIN_SCOPES = 'openid profile email w_member_social';
const LINKEDIN_API_VERSION = '202605';
const videoUploadSchema = z.object({
  value: z.object({
    video: z.string().regex(/^urn:li:video:[^\s]+$/),
    uploadToken: z.string(),
    uploadUrlsExpireAt: z.number().int().positive(),
    uploadInstructions: z
      .array(
        z.object({
          firstByte: z.number().int().nonnegative(),
          lastByte: z.number().int().nonnegative(),
          uploadUrl: z.url(),
        }),
      )
      .min(1),
  }),
});
const videoStatusSchema = z.object({
  id: z.string().regex(/^urn:li:video:[^\s]+$/),
  owner: z.string().regex(/^urn:li:person:[^\s]+$/),
  status: z.enum(['WAITING_UPLOAD', 'PROCESSING', 'PROCESSING_FAILED', 'AVAILABLE']),
});
const imageUploadSchema = z.object({
  value: z.object({
    image: z.string().regex(/^urn:li:image:[^\s]+$/),
    uploadUrl: z.url(),
    uploadUrlExpiresAt: z.number().int().positive(),
  }),
});
const imageStatusSchema = z.object({
  id: z.string().regex(/^urn:li:image:[^\s]+$/),
  owner: z.string().regex(/^urn:li:person:[^\s]+$/),
  status: z.enum(['WAITING_UPLOAD', 'PROCESSING', 'PROCESSING_FAILED', 'AVAILABLE']),
});

function videoHeaders(credential: LinkedInCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    'Content-Type': 'application/json',
    'Linkedin-Version': LINKEDIN_API_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
  };
}

function trustedUploadUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !['linkedin.com', 'linkedin-ei.com'].some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    )
  )
    throw new Error('LinkedIn video upload URL is not trusted');
  return value;
}

export interface LinkedInCredential {
  accessToken: string;
  expiresAt: string;
  memberUrn: string;
  scope: string;
}

export class LinkedInRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly kind: 'auth' | 'rate_limit' | 'validation' | 'transient' | 'permanent',
    message: string,
    public readonly outcomeUnknown = false,
  ) {
    super(message);
  }
}

/** Readiness failures occur before the publication POST and are safe to retry. */
export class LinkedInVideoReadinessError extends Error {
  constructor(
    message: string,
    public readonly permanent = false,
  ) {
    super(message);
  }
}

function classifyStatus(status: number): LinkedInRequestError['kind'] {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 404 || status === 422) return 'validation';
  if (status >= 500) return 'transient';
  return 'permanent';
}

export class LinkedInHttpClient {
  private readonly request: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      clientId: string;
      clientSecret: string;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {
    if (!options.clientId || !options.clientSecret)
      throw new Error('LinkedIn OAuth credentials are required');
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  authorizationUrl(input: { redirectUri: string; state: string }): string {
    const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.options.clientId,
      redirect_uri: input.redirectUri,
      scope: LINKEDIN_SCOPES,
      state: input.state,
    }).toString();
    return url.toString();
  }

  async exchangeCode(input: { code: string; redirectUri: string }): Promise<LinkedInCredential> {
    const response = await this.request('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      }),
    });
    if (!response.ok)
      throw new LinkedInRequestError(
        response.status,
        classifyStatus(response.status),
        'LinkedIn token exchange failed',
      );
    const token = tokenSchema.parse(await response.json());
    if (token.scope && !token.scope.split(/[\s,]+/).includes('w_member_social')) {
      throw new Error('LinkedIn did not grant member posting scope');
    }
    const profile = await this.discoverMember(token.access_token);
    return {
      accessToken: token.access_token,
      expiresAt: new Date(this.now() + token.expires_in * 1000).toISOString(),
      memberUrn: profile.memberUrn,
      scope: token.scope ?? LINKEDIN_SCOPES,
    };
  }

  async discoverMember(accessToken: string): Promise<{ memberUrn: string; displayName: string }> {
    const response = await this.request('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok)
      throw new LinkedInRequestError(
        response.status,
        classifyStatus(response.status),
        'LinkedIn member discovery failed',
      );
    const profile = profileSchema.parse(await response.json());
    return {
      memberUrn: `urn:li:person:${profile.sub}`,
      displayName: profile.name ?? 'LinkedIn member',
    };
  }

  async publishText(input: { credential: LinkedInCredential; text: string }): Promise<string> {
    return this.publishPost(input.credential, input.text);
  }

  async uploadImage(input: {
    credential: LinkedInCredential;
    bytes: Buffer;
    mimeType: string;
  }): Promise<string> {
    if (
      !['image/jpeg', 'image/png'].includes(input.mimeType) ||
      input.bytes.length < 1 ||
      input.bytes.length > 5_000_000
    )
      throw new Error('LinkedIn image requires a JPEG or PNG up to 5 MB');
    const initialized = await this.request(
      'https://api.linkedin.com/rest/images?action=initializeUpload',
      {
        method: 'POST',
        headers: videoHeaders(input.credential),
        body: JSON.stringify({ initializeUploadRequest: { owner: input.credential.memberUrn } }),
      },
    );
    if (!initialized.ok)
      throw new LinkedInRequestError(
        initialized.status,
        classifyStatus(initialized.status),
        `LinkedIn image initialization failed (HTTP ${String(initialized.status)})`,
      );
    const session = imageUploadSchema.parse(await initialized.json()).value;
    if (session.uploadUrlExpiresAt <= this.now())
      throw new Error('LinkedIn image upload URL expired');
    const uploaded = await this.request(trustedUploadUrl(session.uploadUrl), {
      method: 'PUT',
      headers: { 'Content-Type': input.mimeType },
      body: new Uint8Array(input.bytes),
      redirect: 'error',
    });
    if (!uploaded.ok)
      throw new LinkedInRequestError(
        uploaded.status,
        classifyStatus(uploaded.status),
        `LinkedIn image upload failed (HTTP ${String(uploaded.status)})`,
      );
    return session.image;
  }

  async getImageStatus(input: {
    credential: LinkedInCredential;
    image: string;
  }): Promise<'WAITING_UPLOAD' | 'PROCESSING' | 'PROCESSING_FAILED' | 'AVAILABLE'> {
    if (!/^urn:li:image:[^\s]+$/.test(input.image)) throw new Error('Invalid LinkedIn image URN');
    const response = await this.request(
      `https://api.linkedin.com/rest/images/${encodeURIComponent(input.image)}`,
      {
        headers: {
          Authorization: `Bearer ${input.credential.accessToken}`,
          'X-Restli-Protocol-Version': '2.0.0',
        },
      },
    );
    if (!response.ok)
      throw new LinkedInRequestError(
        response.status,
        classifyStatus(response.status),
        `LinkedIn image status failed (HTTP ${String(response.status)})`,
      );
    const image = imageStatusSchema.parse(await response.json());
    if (image.id !== input.image || image.owner !== input.credential.memberUrn)
      throw new LinkedInRequestError(0, 'validation', 'LinkedIn image owner or identity mismatch');
    return image.status;
  }

  async publishImage(input: {
    credential: LinkedInCredential;
    text: string;
    image: string;
  }): Promise<string> {
    return this.publishPost(input.credential, input.text, { media: { id: input.image } });
  }

  async publishMultiImage(input: {
    credential: LinkedInCredential;
    text: string;
    images: string[];
  }): Promise<string> {
    if (
      input.images.length < 2 ||
      input.images.length > 20 ||
      input.images.some((image) => !/^urn:li:image:[^\s]+$/.test(image))
    )
      throw new Error('LinkedIn multi-image requires 2 to 20 verified image URNs');
    return this.publishPost(input.credential, input.text, {
      multiImage: { images: input.images.map((id) => ({ id })) },
    });
  }

  async uploadVideo(input: { credential: LinkedInCredential; bytes: Buffer }): Promise<string> {
    const { credential, bytes } = input;
    if (bytes.length < 75_000 || bytes.length > 500_000_000)
      throw new Error('LinkedIn member video must be between 75 kB and 500 MB');
    const initialized = await this.request(
      'https://api.linkedin.com/rest/videos?action=initializeUpload',
      {
        method: 'POST',
        headers: videoHeaders(credential),
        body: JSON.stringify({
          initializeUploadRequest: {
            owner: credential.memberUrn,
            fileSizeBytes: bytes.length,
            uploadCaptions: false,
            uploadThumbnail: false,
          },
        }),
      },
    );
    if (!initialized.ok)
      throw new LinkedInRequestError(
        initialized.status,
        classifyStatus(initialized.status),
        `LinkedIn video initialization failed (HTTP ${String(initialized.status)})`,
      );
    const session = videoUploadSchema.parse(await initialized.json()).value;
    if (session.uploadUrlsExpireAt <= this.now())
      throw new Error('LinkedIn video upload URLs expired');
    const uploadedPartIds: string[] = [];
    let nextByte = 0;
    for (const instruction of session.uploadInstructions) {
      if (
        instruction.firstByte !== nextByte ||
        instruction.lastByte < nextByte ||
        instruction.lastByte >= bytes.length
      )
        throw new Error('LinkedIn video upload ranges are invalid');
      const uploadUrl = trustedUploadUrl(instruction.uploadUrl);
      const uploaded = await this.request(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(bytes.subarray(instruction.firstByte, instruction.lastByte + 1)),
        redirect: 'error',
      });
      if (!uploaded.ok)
        throw new LinkedInRequestError(
          uploaded.status,
          classifyStatus(uploaded.status),
          `LinkedIn video part upload failed (HTTP ${String(uploaded.status)})`,
        );
      const partId = uploaded.headers.get('etag')?.replace(/^"|"$/g, '');
      if (!partId) throw new Error('LinkedIn video upload part receipt is missing');
      uploadedPartIds.push(partId);
      nextByte = instruction.lastByte + 1;
    }
    if (nextByte !== bytes.length) throw new Error('LinkedIn video upload ranges are incomplete');
    const finalized = await this.request(
      'https://api.linkedin.com/rest/videos?action=finalizeUpload',
      {
        method: 'POST',
        headers: videoHeaders(credential),
        body: JSON.stringify({
          finalizeUploadRequest: {
            video: session.video,
            uploadToken: session.uploadToken,
            uploadedPartIds,
          },
        }),
      },
    );
    if (!finalized.ok)
      throw new LinkedInRequestError(
        finalized.status,
        classifyStatus(finalized.status),
        `LinkedIn video finalization failed (HTTP ${String(finalized.status)})`,
      );
    return session.video;
  }

  async getVideoStatus(input: {
    credential: LinkedInCredential;
    video: string;
  }): Promise<'WAITING_UPLOAD' | 'PROCESSING' | 'PROCESSING_FAILED' | 'AVAILABLE'> {
    if (!/^urn:li:video:[^\s]+$/.test(input.video)) throw new Error('Invalid LinkedIn video URN');
    const response = await this.request(
      `https://api.linkedin.com/rest/videos/${encodeURIComponent(input.video)}`,
      { headers: videoHeaders(input.credential) },
    );
    if (!response.ok)
      throw new LinkedInRequestError(
        response.status,
        classifyStatus(response.status),
        `LinkedIn video status failed (HTTP ${String(response.status)})`,
      );
    const video = videoStatusSchema.parse(await response.json());
    if (video.id !== input.video || video.owner !== input.credential.memberUrn)
      throw new LinkedInRequestError(0, 'validation', 'LinkedIn video owner or identity mismatch');
    return video.status;
  }

  async publishArticle(input: {
    credential: LinkedInCredential;
    text: string;
    linkUrl: string;
    title: string;
    description?: string;
  }): Promise<string> {
    return this.publishPost(input.credential, input.text, {
      article: {
        source: input.linkUrl,
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
      },
    });
  }

  async publishVideo(input: {
    credential: LinkedInCredential;
    text: string;
    video: string;
    title: string;
  }): Promise<string> {
    let status: Awaited<ReturnType<LinkedInHttpClient['getVideoStatus']>>;
    try {
      status = await this.getVideoStatus({ credential: input.credential, video: input.video });
    } catch (error) {
      if (error instanceof LinkedInRequestError && error.kind === 'auth') throw error;
      throw new LinkedInVideoReadinessError(
        'LinkedIn video readiness could not be verified',
        error instanceof LinkedInRequestError && error.kind === 'validation',
      );
    }
    if (status !== 'AVAILABLE')
      throw new LinkedInVideoReadinessError(
        `LinkedIn video cannot be posted while ${status}`,
        status === 'PROCESSING_FAILED',
      );
    return this.publishPost(input.credential, input.text, {
      media: { id: input.video, title: input.title },
    });
  }

  private async publishPost(
    credential: LinkedInCredential,
    text: string,
    content?:
      | { article: { source: string; title: string; description?: string; thumbnail?: string } }
      | { multiImage: { images: { id: string }[] } }
      | { media: { id: string; title?: string } },
  ): Promise<string> {
    const response = await this.request('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        'Content-Type': 'application/json',
        'Linkedin-Version': LINKEDIN_API_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify({
        author: credential.memberUrn,
        commentary: text,
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
        ...(content ? { content } : {}),
      }),
    });
    if (!response.ok)
      throw new LinkedInRequestError(
        response.status,
        classifyStatus(response.status),
        `LinkedIn post failed (HTTP ${String(response.status)})`,
      );
    const postId = response.headers.get('x-restli-id');
    if (!postId)
      throw new LinkedInRequestError(
        0,
        'permanent',
        'LinkedIn accepted the post without a receipt',
        true,
      );
    return postId;
  }
}
