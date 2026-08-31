export const PROVIDER_ADAPTER_VERSION = '1.0' as const;

export interface MediaReference {
  id: string;
  mimeType: string;
  altText?: string;
}

export type PublishContent =
  | { kind: 'text'; text: string; media: MediaReference[] }
  | { kind: 'quote'; text: string; quotedPostId: string; media: MediaReference[] }
  | { kind: 'article'; title: string; body: string; media: MediaReference[] };

export type ProviderErrorCode = 'auth' | 'rate_limit' | 'validation' | 'transient' | 'permanent';

export type PublishOutcome =
  | { status: 'published'; externalPostId: string; externalUrl: string }
  | { status: 'accepted_pending'; providerJobId: string }
  | { status: 'unknown'; reconciliationKey: string }
  | { status: 'failed'; code: ProviderErrorCode; message: string; retryAfterSeconds?: number };

export interface ProviderAccount {
  id: string;
  displayName: string;
}

export interface StagedPublish {
  stageId: string;
  accountId: string;
  content: PublishContent;
  idempotencyKey: string;
}

export interface ProviderAdapter {
  readonly version: typeof PROVIDER_ADAPTER_VERSION;
  connect(authorizationCode: string): Promise<{ credential: string }>;
  discover(credential: string): Promise<ProviderAccount[]>;
  validate(accountId: string, content: PublishContent): Promise<void>;
  stage(accountId: string, content: PublishContent, idempotencyKey: string): Promise<StagedPublish>;
  publish(staged: StagedPublish): Promise<PublishOutcome>;
  lookup(reconciliationKey: string): Promise<PublishOutcome>;
  revoke(credential: string): Promise<void>;
}
