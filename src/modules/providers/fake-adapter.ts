import {
  PROVIDER_ADAPTER_VERSION,
  type ProviderAccount,
  type ProviderAdapter,
  type PublishContent,
  type PublishOutcome,
  type StagedPublish,
} from './contract.js';

export class DeterministicFakeProviderAdapter implements ProviderAdapter {
  public readonly destinationProvider = 'x' as const;
  public readonly version = PROVIDER_ADAPTER_VERSION;
  public readonly capabilities = {
    providerFamily: 'fake',
    contentKinds: ['text', 'quote', 'article', 'video'],
    supportedMediaTypes: ['image/*', 'video/mp4'],
    accountTargetMode: 'single_account',
    dispatchMode: 'immediate_or_scheduled',
    verifiedLimits: {},
  } as const;
  private readonly staged = new Map<string, StagedPublish>();

  public constructor(
    private readonly accounts: readonly ProviderAccount[],
    private outcome: PublishOutcome,
  ) {}

  public connect(authorizationCode: string): Promise<{ credential: string }> {
    if (!authorizationCode) return Promise.reject(new Error('Authorization code is required'));
    return Promise.resolve({ credential: `fake:${authorizationCode}` });
  }

  public discover(credential: string): Promise<ProviderAccount[]> {
    if (!credential.startsWith('fake:')) return Promise.reject(new Error('Invalid credential'));
    return Promise.resolve(this.accounts.map((account) => ({ ...account })));
  }

  public validate(accountId: string, content: PublishContent): Promise<void> {
    if (!this.accounts.some((account) => account.id === accountId))
      return Promise.reject(new Error('Unknown provider account'));
    const text =
      content.kind === 'article'
        ? `${content.title}${content.body}`
        : content.kind === 'video'
          ? content.providerOptions.youtube.title
          : content.text;
    if (!text.trim()) return Promise.reject(new Error('Content must not be empty'));
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
    const staged = {
      stageId: `stage:${idempotencyKey}`,
      accountId,
      content: structuredClone(content),
      idempotencyKey,
    };
    this.staged.set(idempotencyKey, staged);
    return structuredClone(staged);
  }

  public publish(staged: StagedPublish): Promise<PublishOutcome> {
    void staged;
    return Promise.resolve(structuredClone(this.outcome));
  }

  public lookup(reconciliationKey: string): Promise<PublishOutcome> {
    void reconciliationKey;
    return Promise.resolve(structuredClone(this.outcome));
  }

  public revoke(credential: string): Promise<void> {
    void credential;
    return Promise.resolve();
  }

  public setOutcome(outcome: PublishOutcome): void {
    this.outcome = outcome;
  }
}
