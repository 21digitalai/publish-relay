export const PROVIDER_ADAPTER_VERSION = '1.1' as const;

export type ConnectionFamily = 'x' | 'youtube' | 'meta';
export type DestinationProvider = 'x' | 'youtube' | 'instagram' | 'facebook_page';

export interface YouTubeVideoOptions {
  schemaVersion: 1;
  title: string;
  description?: string;
  privacyStatus: 'public' | 'unlisted' | 'private';
  madeForKids: boolean;
  notifySubscribers: boolean;
  tags?: string[];
  categoryId?: string;
}

export interface ProviderTechnicalCapabilities {
  readonly providerFamily: string;
  readonly contentKinds: readonly PublishContent['kind'][];
  readonly supportedMediaTypes: readonly string[];
  readonly accountTargetMode: 'single_account';
  readonly dispatchMode: 'immediate_or_scheduled';
  readonly verifiedLimits: Readonly<Record<string, number>>;
}

export interface MediaReference {
  id: string;
  mimeType: string;
  altText?: string;
}

export type PublishContent =
  | { kind: 'text'; text: string; media: MediaReference[] }
  | { kind: 'link'; text: string; url: string; media: [] }
  | { kind: 'quote'; text: string; quotedPostId: string; media: MediaReference[] }
  | { kind: 'article'; title: string; body: string; media: MediaReference[] }
  | {
      kind: 'video';
      text: string;
      media: [MediaReference];
      providerOptions: { youtube: YouTubeVideoOptions };
    };

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

export interface ProviderConnectionDriver {
  connect(authorizationCode: string): Promise<{ credential: string }>;
  discover(credential: string): Promise<ProviderAccount[]>;
  revoke(credential: string): Promise<void>;
}

export interface PublishingAdapter {
  readonly destinationProvider: DestinationProvider;
  readonly version: typeof PROVIDER_ADAPTER_VERSION;
  readonly capabilities: ProviderTechnicalCapabilities;
  validate(accountId: string, content: PublishContent): Promise<void>;
  stage(accountId: string, content: PublishContent, idempotencyKey: string): Promise<StagedPublish>;
  publish(staged: StagedPublish): Promise<PublishOutcome>;
  lookup(reconciliationKey: string): Promise<PublishOutcome>;
}

/** Compatibility shape for the existing X and YouTube combined implementations. */
export interface ProviderAdapter extends ProviderConnectionDriver, PublishingAdapter {}
