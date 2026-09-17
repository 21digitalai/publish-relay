import type {
  MediaReference,
  ProviderTechnicalCapabilities,
  PublishContent,
  PublishingAdapter,
  PublishOutcome,
  StagedPublish,
} from './contract.js';
import {
  FacebookRequestError,
  type FacebookErrorEvidence,
  type FacebookHttpClient,
} from './facebook-http-client.js';

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const;

export type FacebookArtifactPhase =
  | 'initialized'
  | 'request_started'
  | 'provider_result'
  | 'permalink_resolved'
  | 'reconciliation_required'
  | 'terminal_error';

export interface FacebookArtifact {
  key: string;
  phase: FacebookArtifactPhase;
  externalObjectId?: string;
  externalUrl?: string;
  evidence?: FacebookErrorEvidence;
}

export interface FacebookArtifactStore {
  ensure(input: { key: string; mediaId?: string }): Promise<FacebookArtifact>;
  update(key: string, update: Omit<FacebookArtifact, 'key'>): Promise<FacebookArtifact>;
}

export interface FacebookAdapterRuntime {
  client: FacebookHttpClient;
  artifacts: FacebookArtifactStore;
  accessToken(accountId: string): Promise<string>;
  mediaUrl(mediaId: string): Promise<string>;
}

export const FACEBOOK_CAPABILITIES: ProviderTechnicalCapabilities = {
  providerFamily: 'meta',
  contentKinds: ['link', 'text'],
  supportedMediaTypes: SUPPORTED_IMAGE_TYPES,
  accountTargetMode: 'single_account',
  dispatchMode: 'immediate_or_scheduled',
  verifiedLimits: { maxImages: 1 },
};

type FacebookContent =
  Extract<PublishContent, { kind: 'link' }> | Extract<PublishContent, { kind: 'text' }>;

function contentForFacebook(content: PublishContent): FacebookContent {
  if (content.kind === 'link') {
    const parsed = new URL(content.url);
    if (parsed.protocol !== 'https:')
      throw new Error('Facebook link posts require one canonical HTTPS URL and no media');
    return { ...content, url: parsed.toString() };
  }
  if (content.kind !== 'text' || content.media.length !== 1)
    throw new Error('Facebook phase one supports one link or one JPEG/PNG image');
  const media = content.media[0];
  if (!media || !SUPPORTED_IMAGE_TYPES.includes(media.mimeType as never))
    throw new Error('Facebook phase one supports one JPEG/PNG image');
  return content;
}

function artifactKey(stageId: string): string {
  return `${stageId}:create`;
}

function derivedPermalink(externalObjectId: string): string {
  return `https://www.facebook.com/${encodeURIComponent(externalObjectId)}`;
}

export class FacebookPublishingAdapter implements PublishingAdapter {
  public readonly destinationProvider = 'facebook_page' as const;
  public readonly version = '1.1' as const;
  public readonly capabilities = FACEBOOK_CAPABILITIES;

  public constructor(private readonly runtime: FacebookAdapterRuntime) {}

  public validate(accountId: string, content: PublishContent): Promise<void> {
    if (!accountId) throw new Error('Facebook Page destination is unavailable');
    contentForFacebook(content);
    return Promise.resolve();
  }

  public async stage(
    accountId: string,
    content: PublishContent,
    idempotencyKey: string,
  ): Promise<StagedPublish> {
    await this.validate(accountId, content);
    return { stageId: `facebook_page:${idempotencyKey}`, accountId, content, idempotencyKey };
  }

  public async publish(staged: StagedPublish): Promise<PublishOutcome> {
    const content = contentForFacebook(staged.content);
    const key = artifactKey(staged.stageId);
    const media = content.kind === 'text' ? content.media[0] : undefined;
    let artifact = await this.runtime.artifacts.ensure({
      key,
      ...(media ? { mediaId: media.id } : {}),
    });
    if (artifact.phase === 'request_started' || artifact.phase === 'reconciliation_required')
      return { status: 'unknown', reconciliationKey: key };
    const token = await this.runtime.accessToken(staged.accountId);
    try {
      if (!artifact.externalObjectId) {
        await this.runtime.artifacts.update(key, { phase: 'request_started' });
        const externalObjectId = await this.create(staged.accountId, content, token, media);
        artifact = await this.runtime.artifacts.update(key, {
          phase: 'provider_result',
          externalObjectId,
        });
      }
      if (!artifact.externalObjectId) throw new Error('Facebook provider ID is missing');
      if (!artifact.externalUrl) {
        let externalUrl: string;
        let source: 'authoritative' | 'derived';
        try {
          externalUrl = await this.runtime.client.getPermalink(artifact.externalObjectId, token);
          source = 'authoritative';
        } catch {
          externalUrl = derivedPermalink(artifact.externalObjectId);
          source = 'derived';
        }
        artifact = await this.runtime.artifacts.update(key, {
          phase: 'permalink_resolved',
          externalObjectId: artifact.externalObjectId,
          externalUrl,
          evidence: { kind: 'permanent', status: 0, permalinkSource: source },
        });
      }
      const externalPostId = artifact.externalObjectId;
      if (!externalPostId) throw new Error('Facebook provider ID is missing');
      return {
        status: 'published',
        externalPostId,
        externalUrl: artifact.externalUrl ?? derivedPermalink(externalPostId),
      };
    } catch (error) {
      if (!(error instanceof FacebookRequestError)) throw error;
      if (error.outcomeUnknown) {
        await this.runtime.artifacts.update(key, {
          phase: 'reconciliation_required',
          evidence: error.evidence,
        });
        return { status: 'unknown', reconciliationKey: key };
      }
      await this.runtime.artifacts.update(key, {
        phase: 'terminal_error',
        evidence: error.evidence,
      });
      return {
        status: 'failed',
        code:
          error.evidence.kind === 'permission'
            ? 'auth'
            : error.evidence.kind === 'rate_limit'
              ? 'rate_limit'
              : error.evidence.kind,
        message: error.message,
        ...(error.evidence.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: error.evidence.retryAfterSeconds }),
      };
    }
  }

  public lookup(reconciliationKey: string): Promise<PublishOutcome> {
    return Promise.resolve({ status: 'unknown', reconciliationKey });
  }

  private async create(
    pageId: string,
    content: FacebookContent,
    accessToken: string,
    media?: MediaReference,
  ): Promise<string> {
    if (content.kind === 'link') {
      return this.runtime.client.publishLink({
        pageId,
        link: content.url,
        ...(content.text.trim() ? { message: content.text.trim() } : {}),
        accessToken,
      });
    }
    if (!media) throw new Error('Facebook image is missing');
    const imageUrl = new URL(await this.runtime.mediaUrl(media.id));
    if (imageUrl.protocol !== 'https:')
      throw new Error('Facebook provider media URL must use HTTPS');
    return this.runtime.client.publishPhoto({
      pageId,
      imageUrl: imageUrl.toString(),
      message: content.text.trim(),
      accessToken,
    });
  }
}
