import type {
  MediaReference,
  ProviderTechnicalCapabilities,
  PublishContent,
  PublishingAdapter,
  PublishOutcome,
  StagedPublish,
} from './contract.js';
import {
  InstagramRequestError,
  type InstagramErrorEvidence,
  type InstagramHttpClient,
} from './instagram-http-client.js';

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const;
const MAX_CAROUSEL_IMAGES = 10;

export type InstagramArtifactKind = 'child' | 'parent' | 'publish' | 'permalink';
export type InstagramArtifactPhase =
  | 'initialized'
  | 'request_started'
  | 'created'
  | 'finished'
  | 'published'
  | 'terminal_error'
  | 'reconciliation_required'
  | 'cancelled'
  | 'cleaned';

export interface InstagramArtifact {
  key: string;
  kind: InstagramArtifactKind;
  phase: InstagramArtifactPhase;
  externalObjectId?: string;
  evidence?: InstagramErrorEvidence;
}

export interface InstagramArtifactStore {
  ensure(input: {
    key: string;
    kind: InstagramArtifactKind;
    mediaId?: string;
  }): Promise<InstagramArtifact>;
  update(key: string, update: Omit<InstagramArtifact, 'key' | 'kind'>): Promise<InstagramArtifact>;
}

export interface InstagramAdapterRuntime {
  client: InstagramHttpClient;
  artifacts: InstagramArtifactStore;
  accessToken(accountId: string): Promise<string>;
  mediaUrl(mediaId: string): Promise<string>;
}

export const INSTAGRAM_CAPABILITIES: ProviderTechnicalCapabilities = {
  providerFamily: 'meta',
  contentKinds: ['text'],
  supportedMediaTypes: SUPPORTED_IMAGE_TYPES,
  accountTargetMode: 'single_account',
  dispatchMode: 'immediate_or_scheduled',
  verifiedLimits: { minImages: 1, maxCarouselImages: MAX_CAROUSEL_IMAGES },
};

type InstagramContent = Extract<PublishContent, { kind: 'text' }>;

function instagramContent(content: PublishContent): InstagramContent {
  if (content.kind !== 'text') throw new Error('Instagram phase one supports image posts only');
  if (!content.text.trim()) throw new Error('Instagram caption is required');
  if (content.media.length === 0) throw new Error('Instagram text-only posts are not supported');
  if (content.media.length > MAX_CAROUSEL_IMAGES)
    throw new Error('Instagram carousel supports at most 10 images');
  for (const media of content.media) {
    if (!SUPPORTED_IMAGE_TYPES.includes(media.mimeType as (typeof SUPPORTED_IMAGE_TYPES)[number]))
      throw new Error('Instagram phase one supports JPEG and PNG images only');
  }
  return content;
}

function assertHttps(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Instagram provider media URL must use HTTPS');
  return parsed.toString();
}

function artifactKey(stageId: string, kind: InstagramArtifactKind, suffix = ''): string {
  return `${stageId}:${kind}${suffix ? `:${suffix}` : ''}`;
}

export class InstagramPublishingAdapter implements PublishingAdapter {
  public readonly destinationProvider = 'instagram' as const;
  public readonly version = '1.1' as const;
  public readonly capabilities = INSTAGRAM_CAPABILITIES;

  public constructor(private readonly runtime: InstagramAdapterRuntime) {}

  public validate(accountId: string, content: PublishContent): Promise<void> {
    if (!accountId) throw new Error('Instagram destination is unavailable');
    instagramContent(content);
    return Promise.resolve();
  }

  public async stage(
    accountId: string,
    content: PublishContent,
    idempotencyKey: string,
  ): Promise<StagedPublish> {
    await this.validate(accountId, content);
    return { stageId: `instagram:${idempotencyKey}`, accountId, content, idempotencyKey };
  }

  public async publish(staged: StagedPublish): Promise<PublishOutcome> {
    const content = instagramContent(staged.content);
    const media = content.media;
    const token = await this.runtime.accessToken(staged.accountId);
    try {
      const childIds: string[] = [];
      for (const [index, item] of media.entries()) {
        childIds.push(await this.ensureChild(staged, item, index, token));
      }
      const onlyChild = childIds[0];
      const creationId =
        childIds.length === 1 && onlyChild
          ? onlyChild
          : await this.ensureParent(staged, childIds, content.text, token);
      if (!creationId) throw new Error('Instagram creation ID is missing');
      const mediaId = await this.ensurePublished(staged, creationId, token);
      const permalink = await this.ensurePermalink(staged, mediaId, token);
      return { status: 'published', externalPostId: mediaId, externalUrl: permalink };
    } catch (error) {
      if (error instanceof InstagramRequestError && error.outcomeUnknown) {
        const key = error.reconciliationKey ?? artifactKey(staged.stageId, 'publish');
        await this.runtime.artifacts.update(key, {
          phase: 'reconciliation_required',
          evidence: error.evidence,
        });
        return { status: 'unknown', reconciliationKey: key };
      }
      if (error instanceof InstagramRequestError) {
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
      throw error;
    }
  }

  public lookup(reconciliationKey: string): Promise<PublishOutcome> {
    return Promise.resolve({ status: 'unknown', reconciliationKey });
  }

  private async ensureChild(
    staged: StagedPublish,
    media: MediaReference,
    index: number,
    token: string,
  ): Promise<string> {
    const key = artifactKey(staged.stageId, 'child', String(index));
    let artifact = await this.runtime.artifacts.ensure({ key, kind: 'child', mediaId: media.id });
    if (artifact.phase === 'reconciliation_required')
      throw new InstagramRequestError(
        artifact.evidence ?? { kind: 'transient', status: 0 },
        true,
        key,
      );
    if (artifact.phase === 'request_started' && !artifact.externalObjectId)
      throw new InstagramRequestError({ kind: 'transient', status: 0 }, true);
    if (!artifact.externalObjectId) {
      artifact = await this.runtime.artifacts.update(key, { phase: 'request_started' });
      const imageUrl = assertHttps(await this.runtime.mediaUrl(media.id));
      let externalObjectId: string;
      try {
        externalObjectId = await this.runtime.client.createImageContainer({
          accountId: staged.accountId,
          imageUrl,
          ...(instagramContent(staged.content).media.length === 1
            ? { caption: instagramContent(staged.content).text }
            : {}),
          isCarouselItem: instagramContent(staged.content).media.length > 1,
          accessToken: token,
        });
      } catch (error) {
        if (error instanceof InstagramRequestError && error.outcomeUnknown)
          throw new InstagramRequestError(error.evidence, true, key);
        throw error;
      }
      artifact = await this.runtime.artifacts.update(key, { phase: 'created', externalObjectId });
    }
    if (artifact.phase !== 'finished') {
      const externalObjectId = artifact.externalObjectId;
      if (!externalObjectId) throw new Error('Instagram child container ID is missing');
      const status = await this.runtime.client.getContainerStatus(externalObjectId, token);
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        await this.runtime.artifacts.update(key, {
          phase: 'terminal_error',
          externalObjectId,
        });
        throw new InstagramRequestError({ kind: 'permanent', status: 422 });
      }
      if (status.status_code !== 'FINISHED')
        throw new InstagramRequestError({ kind: 'transient', status: 202 });
      artifact = await this.runtime.artifacts.update(key, {
        phase: 'finished',
        externalObjectId,
      });
    }
    if (!artifact.externalObjectId) throw new Error('Instagram child container ID is missing');
    return artifact.externalObjectId;
  }

  private async ensureParent(
    staged: StagedPublish,
    childIds: readonly string[],
    caption: string,
    token: string,
  ): Promise<string> {
    const key = artifactKey(staged.stageId, 'parent');
    let artifact = await this.runtime.artifacts.ensure({ key, kind: 'parent' });
    if (artifact.phase === 'reconciliation_required')
      throw new InstagramRequestError(
        artifact.evidence ?? { kind: 'transient', status: 0 },
        true,
        key,
      );
    if (artifact.phase === 'request_started' && !artifact.externalObjectId)
      throw new InstagramRequestError({ kind: 'transient', status: 0 }, true);
    if (!artifact.externalObjectId) {
      await this.runtime.artifacts.update(key, { phase: 'request_started' });
      let externalObjectId: string;
      try {
        externalObjectId = await this.runtime.client.createCarouselContainer({
          accountId: staged.accountId,
          childIds,
          caption,
          accessToken: token,
        });
      } catch (error) {
        if (error instanceof InstagramRequestError && error.outcomeUnknown)
          throw new InstagramRequestError(error.evidence, true, key);
        throw error;
      }
      artifact = await this.runtime.artifacts.update(key, { phase: 'created', externalObjectId });
    }
    if (artifact.phase !== 'finished') {
      const externalObjectId = artifact.externalObjectId;
      if (!externalObjectId) throw new Error('Instagram parent container ID is missing');
      const status = await this.runtime.client.getContainerStatus(externalObjectId, token);
      if (status.status_code !== 'FINISHED')
        throw new InstagramRequestError({
          kind: status.status_code === 'IN_PROGRESS' ? 'transient' : 'permanent',
          status: 202,
        });
      artifact = await this.runtime.artifacts.update(key, {
        phase: 'finished',
        externalObjectId,
      });
    }
    if (!artifact.externalObjectId) throw new Error('Instagram parent container ID is missing');
    return artifact.externalObjectId;
  }

  private async ensurePublished(staged: StagedPublish, creationId: string, token: string) {
    const key = artifactKey(staged.stageId, 'publish');
    let artifact = await this.runtime.artifacts.ensure({ key, kind: 'publish' });
    if (artifact.phase === 'reconciliation_required')
      throw new InstagramRequestError(artifact.evidence ?? { kind: 'transient', status: 0 }, true);
    if (artifact.phase === 'request_started' && !artifact.externalObjectId)
      throw new InstagramRequestError({ kind: 'transient', status: 0 }, true);
    if (!artifact.externalObjectId) {
      await this.runtime.artifacts.update(key, { phase: 'request_started' });
      const externalObjectId = await this.runtime.client.publish(
        staged.accountId,
        creationId,
        token,
      );
      artifact = await this.runtime.artifacts.update(key, { phase: 'published', externalObjectId });
    }
    if (!artifact.externalObjectId) throw new Error('Instagram published media ID is missing');
    return artifact.externalObjectId;
  }

  private async ensurePermalink(staged: StagedPublish, mediaId: string, token: string) {
    const key = artifactKey(staged.stageId, 'permalink');
    let artifact = await this.runtime.artifacts.ensure({ key, kind: 'permalink' });
    if (!artifact.externalObjectId) {
      const media = await this.runtime.client.getMedia(mediaId, token);
      artifact = await this.runtime.artifacts.update(key, {
        phase: 'finished',
        externalObjectId: media.permalink,
      });
    }
    if (!artifact.externalObjectId) throw new Error('Instagram permalink is missing');
    return artifact.externalObjectId;
  }
}
