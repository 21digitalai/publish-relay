import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

const tokenPayloadSchema = z.object({
  v: z.literal(1),
  workspaceId: z.uuid(),
  mediaId: z.uuid(),
  expiresAt: z.number().int().positive(),
});

export interface InstagramMediaTokenPayload {
  workspaceId: string;
  mediaId: string;
  expiresAt: number;
}

function encode(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function signature(payload: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export class InstagramMediaTokenCodec {
  public constructor(private readonly secret: Buffer) {
    if (secret.byteLength < 32)
      throw new Error('Instagram media signing secret must be at least 32 bytes');
  }

  public issue(input: InstagramMediaTokenPayload): string {
    const payload = encode(
      JSON.stringify({
        v: 1,
        workspaceId: input.workspaceId,
        mediaId: input.mediaId,
        expiresAt: input.expiresAt,
      }),
    );
    return `${payload}.${encode(signature(payload, this.secret))}`;
  }

  public verify(token: string, now = Date.now()): InstagramMediaTokenPayload {
    const [payload, encodedSignature, extra] = token.split('.');
    if (!payload || !encodedSignature || extra) throw new Error('Invalid Instagram media token');
    const received = Buffer.from(encodedSignature, 'base64url');
    const expected = signature(payload, this.secret);
    if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected))
      throw new Error('Invalid Instagram media token');
    const parsed = tokenPayloadSchema.parse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    if (parsed.expiresAt <= now) throw new Error('Instagram media token expired');
    return {
      workspaceId: parsed.workspaceId,
      mediaId: parsed.mediaId,
      expiresAt: parsed.expiresAt,
    };
  }
}
