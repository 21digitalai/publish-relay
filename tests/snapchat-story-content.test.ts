import { expect, it, vi } from 'vitest';
import { createDecipheriv } from 'node:crypto';
import { Readable } from 'node:stream';

import { publicationTargetSchema } from '../src/modules/content/publication-target.js';
import { validateSnapchatStoryMedia } from '../src/modules/providers/snapchat-story-content.js';
import { SnapchatStoryClient } from '../src/modules/providers/snapchat-story-client.js';
import { stageAndPostSnapchatStory } from '../src/modules/providers/snapchat-story-upload.js';

const id = '00000000-0000-4000-8000-000000000101';
const video = { mimeType: 'video/mp4', byteSize: 1024, durationMs: 5_000, width: 540, height: 960 };

it('keeps Story image and video targets distinct from Spotlight with bounded options', () => {
  for (const kind of ['story_image', 'story_video'] as const)
    expect(
      publicationTargetSchema.safeParse({
        provider: 'snapchat',
        providerAccountId: id,
        content: {
          schemaVersion: 1,
          kind,
          mediaId: id,
          customizedTtl: 'THREE_DAYS',
          link: 'https://example.test/story',
        },
      }).success,
    ).toBe(true);
  for (const changed of [{ customizedTtl: 'FOREVER' }, { link: 'file:///tmp/story' }])
    expect(
      publicationTargetSchema.safeParse({
        provider: 'snapchat',
        providerAccountId: id,
        content: { schemaVersion: 1, kind: 'story_image', mediaId: id, ...changed },
      }).success,
    ).toBe(false);
});

it('validates Story video from Snap-specific 5-second boundary and image independently', () => {
  expect(() => {
    validateSnapchatStoryMedia('story_video', video);
  }).not.toThrow();
  for (const changed of [
    { durationMs: 4_999 },
    { durationMs: 60_001 },
    { width: 539 },
    { height: 959 },
    { mimeType: 'image/jpeg' },
    { byteSize: 1_000_000_001 },
  ])
    expect(() => {
      validateSnapchatStoryMedia('story_video', { ...video, ...changed });
    }).toThrow();
  expect(() => {
    validateSnapchatStoryMedia('story_image', {
      ...video,
      mimeType: 'image/jpeg',
      durationMs: null,
      width: null,
      height: null,
    });
  }).not.toThrow();
  expect(() => {
    validateSnapchatStoryMedia('story_image', video);
  }).toThrow();
});

it('uses the pinned transport and treats a Story request ID as correlation only', async () => {
  const fetcher = vi.fn<typeof fetch>((url, init) => {
    expect(url).toBe(`https://businessapi.snapchat.com/v1/public_profiles/${id}/stories`);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fixture');
    if (typeof init?.body !== 'string') throw new Error('Expected JSON request');
    expect(JSON.parse(init.body)).toEqual({
      media_id: id,
      customized_ttl: { ttl: 'THREE_DAYS' },
      link: 'https://example.test/story',
    });
    return Promise.resolve(
      new Response(JSON.stringify({ request_status: 'SUCCESS', request_id: id })),
    );
  });
  const requestId = await new SnapchatStoryClient(fetcher).postStory({
    profileId: id,
    accessToken: 'fixture',
    mediaId: id,
    customizedTtl: 'THREE_DAYS',
    link: 'https://example.test/story',
  });
  expect(requestId).toBe(id);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('encrypts a Story image near dispatch, uploads once, and returns only request correlation', async () => {
  const raw = Buffer.from('story image');
  const remoteMediaId = '00000000-0000-4000-8000-000000000102';
  const path = `/us/v1/public_profiles/${id}/media/${remoteMediaId}/multipart-upload`;
  let key: Buffer | undefined;
  let iv: Buffer | undefined;
  let encrypted: Buffer | undefined;
  const calls: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push(address);
    if (address.endsWith('/media')) {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON media request');
      const body = JSON.parse(init.body) as { type: string; key: string; iv: string };
      expect(body.type).toBe('IMAGE');
      key = Buffer.from(body.key, 'base64');
      iv = Buffer.from(body.iv, 'base64');
      return new Response(
        JSON.stringify({
          request_status: 'SUCCESS',
          media_id: remoteMediaId,
          add_path: path,
          finalize_path: path,
        }),
      );
    }
    if (address.endsWith('/multipart-upload')) {
      const form = init?.body as FormData;
      if (form.get('action') === 'ADD')
        encrypted = Buffer.from(await (form.get('file') as Blob).arrayBuffer());
      return new Response(JSON.stringify({ request_status: 'SUCCESS' }));
    }
    if (typeof init?.body !== 'string') throw new Error('Expected JSON Story request');
    expect(JSON.parse(init.body)).toEqual({ media_id: remoteMediaId });
    return new Response(JSON.stringify({ request_status: 'SUCCESS', request_id: id }));
  });
  const result = await stageAndPostSnapchatStory({
    client: new SnapchatStoryClient(fetcher),
    source: { open: () => Promise.resolve(Readable.from([raw])) },
    workspaceId: id,
    profileId: id,
    accessToken: 'fixture',
    content: { schemaVersion: 1, kind: 'story_image', mediaId: id },
    media: {
      mimeType: 'image/jpeg',
      byteSize: raw.length,
      durationMs: null,
      width: null,
      height: null,
    },
  });
  expect(result).toEqual({ requestId: id, mediaId: remoteMediaId });
  expect(calls.at(-1)).toBe(`https://businessapi.snapchat.com/v1/public_profiles/${id}/stories`);
  expect(encrypted).toBeDefined();
  if (!key || !iv || !encrypted) throw new Error('Expected encrypted media upload');
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  expect(Buffer.concat([decipher.update(encrypted), decipher.final()])).toEqual(raw);
});

it('does not retry an ambiguous Story POST inside the transport', async () => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.reject(new Error('connection lost')));
  await expect(
    new SnapchatStoryClient(fetcher).postStory({
      profileId: id,
      accessToken: 'fixture',
      mediaId: id,
    }),
  ).rejects.toMatchObject({ kind: 'unknown' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('treats a duplicate-in-progress provider refusal as an unknown original POST', async () => {
  const fetcher = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          request_status: 'ERROR',
          error_code: 'MEDIA_POSTING_ALREADY_IN_PROGRESS',
        }),
        { status: 400 },
      ),
    ),
  );
  await expect(
    new SnapchatStoryClient(fetcher).postStory({
      profileId: id,
      accessToken: 'fixture',
      mediaId: id,
    }),
  ).rejects.toMatchObject({ kind: 'unknown' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
