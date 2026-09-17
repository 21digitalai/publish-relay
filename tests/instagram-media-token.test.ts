import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { InstagramMediaTokenCodec } from '../src/modules/providers/instagram-media-token.js';

describe('InstagramMediaTokenCodec', () => {
  it('binds a short-lived token to the exact workspace and media object', () => {
    const codec = new InstagramMediaTokenCodec(randomBytes(32));
    const payload = { workspaceId: randomUUID(), mediaId: randomUUID(), expiresAt: 2_000 };
    const token = codec.issue(payload);
    expect(codec.verify(token, 1_999)).toEqual(payload);
    expect(() => codec.verify(token, 2_000)).toThrow('expired');
  });

  it('keeps workspace and media identifiers opaque to token inspection', () => {
    const codec = new InstagramMediaTokenCodec(randomBytes(32));
    const payload = { workspaceId: randomUUID(), mediaId: randomUUID(), expiresAt: 2_000 };
    const token = codec.issue(payload);
    const inspected = token
      .split('.')
      .map((segment) => Buffer.from(segment, 'base64url').toString('utf8'))
      .join(' ');

    expect(token).not.toContain(payload.workspaceId);
    expect(token).not.toContain(payload.mediaId);
    expect(inspected).not.toContain(payload.workspaceId);
    expect(inspected).not.toContain(payload.mediaId);
  });

  it('rejects tampering and weak signing secrets', () => {
    expect(() => new InstagramMediaTokenCodec(Buffer.alloc(31))).toThrow('at least 32 bytes');
    const codec = new InstagramMediaTokenCodec(randomBytes(32));
    const token = codec.issue({
      workspaceId: randomUUID(),
      mediaId: randomUUID(),
      expiresAt: 2_000,
    });
    expect(() => codec.verify(`${token}x`, 1_000)).toThrow('Invalid');
  });
});
