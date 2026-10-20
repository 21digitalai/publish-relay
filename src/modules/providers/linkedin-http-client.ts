import { z } from 'zod';

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
});
const profileSchema = z.object({ sub: z.string().min(1), name: z.string().optional() });
const LINKEDIN_SCOPES = 'openid profile email w_member_social';
const LINKEDIN_API_VERSION = '202605';

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

  private async publishPost(
    credential: LinkedInCredential,
    text: string,
    content?: { article: { source: string; title: string; description?: string } },
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
