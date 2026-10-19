import { createDecipheriv } from 'node:crypto';
import { Readable } from 'node:stream';

import { expect, it, vi } from 'vitest';

import {
  SnapchatSpotlightClient,
  SnapchatSpotlightRequestError,
} from '../src/modules/providers/snapchat-spotlight-client.js';
import { validateSnapchatSpotlightMedia } from '../src/modules/providers/snapchat-spotlight-content.js';
import { stageAndPostSnapchatSpotlight } from '../src/modules/providers/snapchat-spotlight-upload.js';
import { publicationTargetSchema } from '../src/modules/content/publication-target.js';

const profileId = '00000000-0000-4000-8000-000000000101';
const mediaId = '00000000-0000-4000-8000-000000000102';
const remoteMediaId = '00000000-0000-4000-8000-000000000103';
const path = `/us/v1/public_profiles/${profileId}/media/${remoteMediaId}/multipart-upload`;
const content = {
  schemaVersion: 1,
  kind: 'spotlight_video',
  mediaId,
  locale: 'en_US',
  description: 'A Spotlight',
};
const media = { mimeType: 'video/mp4', byteSize: 12, durationMs: 6_000, width: 540, height: 960 };

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

it('validates Spotlight-specific MP4, timing, dimensions and description', () => {
  expect(() => {
    validateSnapchatSpotlightMedia(media);
  }).not.toThrow();
  for (const changed of [
    { durationMs: 5_999 },
    { durationMs: 60_001 },
    { width: 539 },
    { height: 959 },
    { mimeType: 'video/quicktime' },
    { byteSize: 1_000_000_001 },
  ])
    expect(() => {
      validateSnapchatSpotlightMedia({ ...media, ...changed });
    }).toThrow();
  expect(
    publicationTargetSchema.safeParse({
      provider: 'snapchat',
      providerAccountId: profileId,
      content,
    }).success,
  ).toBe(true);
  expect(
    publicationTargetSchema.safeParse({
      provider: 'snapchat',
      providerAccountId: profileId,
      content: { ...content, description: 'x'.repeat(161) },
    }).success,
  ).toBe(false);
});

it('encrypts near dispatch, uploads, then treats SUBMITTED as pending until LIVE', async () => {
  const raw = Buffer.from('hello world!');
  let key: Buffer | undefined;
  let iv: Buffer | undefined;
  let encrypted: Buffer | undefined;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    expect(address).toMatch(/^https:\/\/businessapi\.snapchat\.com\//);
    expect(init?.redirect).toBe('error');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fixture');
    if (address.endsWith('/media')) {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON media request');
      const body = JSON.parse(init.body) as { key: string; iv: string };
      key = Buffer.from(body.key, 'base64');
      iv = Buffer.from(body.iv, 'base64');
      return reply({
        request_status: 'SUCCESS',
        media_id: remoteMediaId,
        add_path: path,
        finalize_path: path,
      });
    }
    if (address.endsWith('/multipart-upload')) {
      const form = init?.body as FormData;
      if (form.get('action') === 'ADD')
        encrypted = Buffer.from(await (form.get('file') as Blob).arrayBuffer());
      return reply({ request_status: 'SUCCESS' });
    }
    if (init?.method === 'POST') {
      if (typeof init.body !== 'string') throw new Error('Expected JSON Spotlight request');
      expect(JSON.parse(init.body)).toEqual({
        media_id: remoteMediaId,
        locale: 'en_US',
        description: 'A Spotlight',
      });
      return reply({ request_status: 'SUCCESS', spotlight_id: 'spotlight-one' });
    }
    return reply({
      request_status: 'SUCCESS',
      spotlights: [
        {
          sub_request_status: 'SUCCESS',
          spotlight: {
            id: 'spotlight-one',
            profile_id: profileId,
            status: 'SUBMITTED',
          },
        },
      ],
    });
  });
  const client = new SnapchatSpotlightClient(fetcher);
  const staged = await stageAndPostSnapchatSpotlight({
    client,
    workspaceId: profileId,
    profileId,
    accessToken: 'fixture',
    content,
    media,
    source: { open: () => Promise.resolve(Readable.from([raw])) },
  });
  expect(staged.spotlightId).toBe('spotlight-one');
  expect(encrypted).toBeDefined();
  if (!key || !iv || !encrypted) throw new Error('Fixture did not capture encrypted upload');
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  expect(Buffer.concat([decipher.update(encrypted), decipher.final()])).toEqual(raw);
  expect(
    await client.lookup({ profileId, spotlightId: staged.spotlightId, accessToken: 'fixture' }),
  ).toBe('SUBMITTED');
  expect(
    fetcher.mock.calls.map((call) => {
      const target = call[0];
      return (
        typeof target === 'string' ? target : target instanceof URL ? target.href : target.url
      )
        .split('/')
        .at(-1);
    }),
  ).toEqual(['media', 'multipart-upload', 'multipart-upload', 'spotlights', 'spotlight-one']);
});

it('rejects foreign upload paths and treats ambiguous POST as unknown, never a safe retry', async () => {
  const foreign = new SnapchatSpotlightClient(
    vi.fn<typeof fetch>(() =>
      Promise.resolve(
        reply({
          request_status: 'SUCCESS',
          media_id: remoteMediaId,
          add_path: 'https://attacker.example/upload',
          finalize_path: path,
        }),
      ),
    ),
  );
  await expect(
    foreign.createMedia({
      profileId,
      accessToken: 'fixture',
      name: 'fixture',
      key: Buffer.alloc(32),
      iv: Buffer.alloc(16),
    }),
  ).rejects.toMatchObject({ kind: 'permanent' });
  const post = new SnapchatSpotlightClient(
    vi.fn<typeof fetch>(() =>
      Promise.reject(new Error('response lost after provider accepted POST')),
    ),
  );
  await expect(
    post.post({ profileId, accessToken: 'fixture', mediaId: remoteMediaId, locale: 'en_US' }),
  ).rejects.toMatchObject({ kind: 'unknown' });
  expect(SnapchatSpotlightRequestError).toBeDefined();
});
