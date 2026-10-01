import {
  PROVIDER_ADAPTER_VERSION,
  type MediaReference,
  type ProviderAccount,
  type ProviderAdapter,
  type PublishContent,
  type PublishOutcome,
  type StagedPublish,
} from './contract.js';
import { resolveYouTubeSettings } from './youtube-settings.js';

const YOUTUBE_TITLE_MAX_LENGTH = 100;
const YOUTUBE_DESCRIPTION_MAX_LENGTH = 5_000;
const YOUTUBE_TAG_MAX_LENGTH = 500;

function validateVideoContent(
  content: PublishContent,
): asserts content is Extract<PublishContent, { kind: 'video' }> {
  if (content.kind !== 'video') throw new Error('YouTube requires video content');
  const media = content.media as readonly MediaReference[];
  if (media.length !== 1 || media[0]?.mimeType !== 'video/mp4') {
    throw new Error('YouTube requires exactly one MP4 video');
  }
  const options = resolveYouTubeSettings({}, content.providerOptions.youtube);
  if (!options.title.trim() || options.title.length > YOUTUBE_TITLE_MAX_LENGTH) {
    throw new Error('YouTube title must contain 1 to 100 characters');
  }
  if (options.description && options.description.length > YOUTUBE_DESCRIPTION_MAX_LENGTH) {
    throw new Error('YouTube description must not exceed 5000 characters');
  }
  if (options.tags?.some((tag) => !tag.trim())) {
    throw new Error('YouTube tags must not be empty');
  }
  if (options.tags && options.tags.join(',').length > YOUTUBE_TAG_MAX_LENGTH) {
    throw new Error('YouTube tags must not exceed 500 characters');
  }
}

export class YouTubeProviderAdapter implements ProviderAdapter {
  public readonly destinationProvider = 'youtube' as const;
  public readonly version = PROVIDER_ADAPTER_VERSION;
  public readonly capabilities = {
    providerFamily: 'youtube',
    contentKinds: ['video'],
    supportedMediaTypes: ['video/mp4'],
    accountTargetMode: 'single_account',
    dispatchMode: 'immediate_or_scheduled',
    verifiedLimits: {
      videosPerPublication: 1,
      titleCharacters: YOUTUBE_TITLE_MAX_LENGTH,
      descriptionCharacters: YOUTUBE_DESCRIPTION_MAX_LENGTH,
      tagCharacters: YOUTUBE_TAG_MAX_LENGTH,
    },
  } as const;

  public connect(authorizationCode: string): Promise<{ credential: string }> {
    void authorizationCode;
    return Promise.reject(new Error('YouTube OAuth transport is not configured'));
  }

  public discover(credential: string): Promise<ProviderAccount[]> {
    void credential;
    return Promise.reject(new Error('YouTube channel discovery transport is not configured'));
  }

  public validate(accountId: string, content: PublishContent): Promise<void> {
    if (!accountId) return Promise.reject(new Error('YouTube channel is required'));
    try {
      validateVideoContent(content);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Invalid YouTube content'));
    }
  }

  public async stage(
    accountId: string,
    content: PublishContent,
    idempotencyKey: string,
  ): Promise<StagedPublish> {
    await this.validate(accountId, content);
    return {
      stageId: idempotencyKey,
      accountId,
      content: structuredClone(content),
      idempotencyKey,
    };
  }

  public publish(staged: StagedPublish): Promise<PublishOutcome> {
    void staged;
    return Promise.reject(new Error('YouTube resumable upload transport is not configured'));
  }

  public lookup(reconciliationKey: string): Promise<PublishOutcome> {
    void reconciliationKey;
    return Promise.reject(new Error('YouTube reconciliation transport is not configured'));
  }

  public revoke(credential: string): Promise<void> {
    void credential;
    return Promise.reject(new Error('YouTube revocation transport is not configured'));
  }
}
