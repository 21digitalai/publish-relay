/* eslint-disable @typescript-eslint/require-await */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  InstagramPublishingAdapter,
  type InstagramArtifact,
  type InstagramArtifactStore,
} from '../src/modules/providers/instagram-adapter.js';

class MemoryArtifacts implements InstagramArtifactStore {
  public readonly values = new Map<string, InstagramArtifact>();

  public async ensure(input: { key: string; kind: InstagramArtifact['kind'] }) {
    const artifact = this.values.get(input.key) ?? {
      key: input.key,
      kind: input.kind,
      phase: 'initialized' as const,
    };
    this.values.set(input.key, artifact);
    return artifact;
  }

  public async update(key: string, update: Omit<InstagramArtifact, 'key' | 'kind'>) {
    const artifact = this.values.get(key);
    if (!artifact) throw new Error('artifact missing');
    const next = { ...artifact, ...update };
    this.values.set(key, next);
    return next;
  }
}

function imageContent(count = 1) {
  return {
    kind: 'text' as const,
    text: 'Caption',
    media: Array.from({ length: count }, (_, index) => ({
      id: `media-${String(index)}`,
      mimeType: 'image/jpeg',
    })),
  };
}

function setArtifact(
  artifacts: MemoryArtifacts,
  key: string,
  kind: InstagramArtifact['kind'],
  phase: InstagramArtifact['phase'],
  externalObjectId?: string,
) {
  artifacts.values.set(key, {
    key,
    kind,
    phase,
    ...(externalObjectId ? { externalObjectId } : {}),
  });
}

describe('Instagram external-boundary restart recovery', () => {
  const client = {
    createImageContainer: vi.fn(() => Promise.resolve('child-0')),
    createCarouselContainer: vi.fn(() => Promise.resolve('parent-1')),
    getContainerStatus: vi.fn(() => Promise.resolve({ status_code: 'FINISHED' as const })),
    publish: vi.fn(() => Promise.resolve('published-1')),
    getMedia: vi.fn(() =>
      Promise.resolve({ id: 'published-1', permalink: 'https://instagram.com/p/1' }),
    ),
  };

  beforeEach(() => vi.clearAllMocks());

  function adapter(artifacts: MemoryArtifacts) {
    return new InstagramPublishingAdapter({
      client: client as never,
      artifacts,
      accessToken: () => Promise.resolve('token'),
      mediaUrl: () =>
        Promise.resolve('https://relay.example/provider-media/instagram?token=opaque'),
    });
  }

  it('resumes a created child by polling without recreating it', async () => {
    const artifacts = new MemoryArtifacts();
    setArtifact(artifacts, 'instagram:job:child:0', 'child', 'created', 'child-0');

    await expect(
      adapter(artifacts).publish(await adapter(artifacts).stage('ig-1', imageContent(), 'job')),
    ).resolves.toMatchObject({ status: 'published' });
    expect(client.createImageContainer).not.toHaveBeenCalled();
    expect(client.getContainerStatus).toHaveBeenCalledWith('child-0', 'token');
    expect(client.publish).toHaveBeenCalledTimes(1);
  });

  it('resumes finished children and a created parent without recreating containers', async () => {
    const artifacts = new MemoryArtifacts();
    setArtifact(artifacts, 'instagram:job:child:0', 'child', 'finished', 'child-0');
    setArtifact(artifacts, 'instagram:job:child:1', 'child', 'finished', 'child-1');
    setArtifact(artifacts, 'instagram:job:parent', 'parent', 'created', 'parent-1');
    const instance = adapter(artifacts);

    await expect(
      instance.publish(await instance.stage('ig-1', imageContent(2), 'job')),
    ).resolves.toMatchObject({ status: 'published' });
    expect(client.createImageContainer).not.toHaveBeenCalled();
    expect(client.createCarouselContainer).not.toHaveBeenCalled();
    expect(client.getContainerStatus).toHaveBeenCalledTimes(1);
    expect(client.getContainerStatus).toHaveBeenCalledWith('parent-1', 'token');
  });

  it('resumes a published media ID at permalink lookup without replaying publish', async () => {
    const artifacts = new MemoryArtifacts();
    setArtifact(artifacts, 'instagram:job:child:0', 'child', 'finished', 'child-0');
    setArtifact(artifacts, 'instagram:job:publish', 'publish', 'published', 'published-1');
    const instance = adapter(artifacts);

    await expect(
      instance.publish(await instance.stage('ig-1', imageContent(), 'job')),
    ).resolves.toEqual({
      status: 'published',
      externalPostId: 'published-1',
      externalUrl: 'https://instagram.com/p/1',
    });
    expect(client.publish).not.toHaveBeenCalled();
    expect(client.getMedia).toHaveBeenCalledWith('published-1', 'token');
  });

  it('returns fully durable publication state without any provider call', async () => {
    const artifacts = new MemoryArtifacts();
    setArtifact(artifacts, 'instagram:job:child:0', 'child', 'finished', 'child-0');
    setArtifact(artifacts, 'instagram:job:publish', 'publish', 'published', 'published-1');
    setArtifact(
      artifacts,
      'instagram:job:permalink',
      'permalink',
      'finished',
      'https://instagram.com/p/1',
    );
    const instance = adapter(artifacts);

    await expect(
      instance.publish(await instance.stage('ig-1', imageContent(), 'job')),
    ).resolves.toMatchObject({ status: 'published' });
    expect(client.createImageContainer).not.toHaveBeenCalled();
    expect(client.getContainerStatus).not.toHaveBeenCalled();
    expect(client.publish).not.toHaveBeenCalled();
    expect(client.getMedia).not.toHaveBeenCalled();
  });

  it('holds a started publish with no provider ID and never replays it', async () => {
    const artifacts = new MemoryArtifacts();
    setArtifact(artifacts, 'instagram:job:child:0', 'child', 'finished', 'child-0');
    setArtifact(artifacts, 'instagram:job:publish', 'publish', 'request_started');
    const instance = adapter(artifacts);

    await expect(
      instance.publish(await instance.stage('ig-1', imageContent(), 'job')),
    ).resolves.toEqual({ status: 'unknown', reconciliationKey: 'instagram:job:publish' });
    expect(client.publish).not.toHaveBeenCalled();
  });
});
