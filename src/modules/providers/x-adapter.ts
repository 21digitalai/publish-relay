import {
  PROVIDER_ADAPTER_VERSION,
  type ProviderAccount,
  type ProviderAdapter,
  type ProviderErrorCode,
  type PublishContent,
  type PublishOutcome,
  type StagedPublish,
} from './contract.js';

export interface XApiError {
  status: number;
  message: string;
  retryAfterSeconds?: number;
  outcomeUnknown?: boolean;
}

const X_MAX_MEDIA_PER_POST = 4;

export interface XClient {
  connect(authorizationCode: string): Promise<{ credential: string }>;
  currentAccount(credential: string): Promise<{ id: string; name: string; username: string }>;
  createPost(input: {
    text: string;
    mediaIds: string[];
    quoteTweetId?: string;
    idempotencyKey: string;
  }): Promise<{ id: string; username: string }>;
  getPost(id: string): Promise<{ id: string; username: string } | null>;
  revoke(credential: string): Promise<void>;
}

function classifyError(error: XApiError): ProviderErrorCode {
  if (error.status === 401 || error.status === 403) return 'auth';
  if (error.status === 429) return 'rate_limit';
  if (error.status === 400 || error.status === 422) return 'validation';
  if (error.status >= 500) return 'transient';
  return 'permanent';
}

function failedOutcome(error: unknown): PublishOutcome {
  const providerError = error as Partial<XApiError>;
  if (providerError.outcomeUnknown) return { status: 'unknown', reconciliationKey: 'x:unknown' };
  return {
    status: 'failed',
    code: classifyError({ status: providerError.status ?? 0, message: '' }),
    message: providerError.message ?? 'X request failed',
    ...(providerError.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: providerError.retryAfterSeconds }),
  };
}

export class XProviderAdapter implements ProviderAdapter {
  public readonly version = PROVIDER_ADAPTER_VERSION;
  private readonly staged = new Map<string, StagedPublish>();

  public constructor(private readonly client: XClient) {}

  public connect(authorizationCode: string): Promise<{ credential: string }> {
    if (!authorizationCode) return Promise.reject(new Error('Authorization code is required'));
    return this.client.connect(authorizationCode);
  }

  public async discover(credential: string): Promise<ProviderAccount[]> {
    const account = await this.client.currentAccount(credential);
    return [{ id: account.id, displayName: `${account.name} (@${account.username})` }];
  }

  public validate(accountId: string, content: PublishContent): Promise<void> {
    if (!accountId) return Promise.reject(new Error('X account is required'));
    if (content.kind === 'article')
      return Promise.reject(new Error('X article publishing capability is not verified'));
    if (content.media.length > X_MAX_MEDIA_PER_POST)
      return Promise.reject(new Error('X posts support at most 4 media attachments'));
    if (!content.text.trim() && content.media.length === 0)
      return Promise.reject(new Error('X content must include text or media'));
    return Promise.resolve();
  }

  public async stage(
    accountId: string,
    content: PublishContent,
    idempotencyKey: string,
  ): Promise<StagedPublish> {
    await this.validate(accountId, content);
    const existing = this.staged.get(idempotencyKey);
    if (existing) return structuredClone(existing);
    const staged = { stageId: `x:${idempotencyKey}`, accountId, content, idempotencyKey };
    this.staged.set(idempotencyKey, structuredClone(staged));
    return structuredClone(staged);
  }

  public async publish(staged: StagedPublish): Promise<PublishOutcome> {
    if (staged.content.kind === 'article')
      return { status: 'failed', code: 'validation', message: 'X articles are unsupported' };
    try {
      const result = await this.client.createPost({
        text: staged.content.text,
        mediaIds: staged.content.media.map((media) => media.id),
        ...(staged.content.kind === 'quote' ? { quoteTweetId: staged.content.quotedPostId } : {}),
        idempotencyKey: staged.idempotencyKey,
      });
      return {
        status: 'published',
        externalPostId: result.id,
        externalUrl: `https://x.com/${result.username}/status/${result.id}`,
      };
    } catch (error) {
      const outcome = failedOutcome(error);
      return outcome.status === 'unknown'
        ? { ...outcome, reconciliationKey: staged.stageId }
        : outcome;
    }
  }

  public async lookup(reconciliationKey: string): Promise<PublishOutcome> {
    try {
      const post = await this.client.getPost(reconciliationKey.replace(/^x:/, ''));
      return post
        ? {
            status: 'published',
            externalPostId: post.id,
            externalUrl: `https://x.com/${post.username}/status/${post.id}`,
          }
        : { status: 'unknown', reconciliationKey };
    } catch (error) {
      return failedOutcome(error);
    }
  }

  public revoke(credential: string): Promise<void> {
    return this.client.revoke(credential);
  }
}
