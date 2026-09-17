import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

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

const TOKEN_VERSION = 'v1';
const TOKEN_KEY_CONTEXT = 'publish-relay:instagram-media-token:v1';
const NONCE_BYTES = 12;

function encryptionKey(secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(TOKEN_KEY_CONTEXT).digest();
}

export class InstagramMediaTokenCodec {
  private readonly key: Buffer;

  public constructor(secret: Buffer) {
    if (secret.byteLength < 32)
      throw new Error('Instagram media signing secret must be at least 32 bytes');
    this.key = encryptionKey(secret);
  }

  public issue(input: InstagramMediaTokenPayload): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(TOKEN_VERSION));
    const plaintext = JSON.stringify({
      v: 1,
      workspaceId: input.workspaceId,
      mediaId: input.mediaId,
      expiresAt: input.expiresAt,
    });
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [TOKEN_VERSION, encode(nonce), encode(ciphertext), encode(cipher.getAuthTag())].join(
      '.',
    );
  }

  public verify(token: string, now = Date.now()): InstagramMediaTokenPayload {
    try {
      const [version, encodedNonce, encodedCiphertext, encodedTag, extra] = token.split('.');
      if (version !== TOKEN_VERSION || !encodedNonce || !encodedCiphertext || !encodedTag || extra)
        throw new Error('invalid token shape');
      const nonce = Buffer.from(encodedNonce, 'base64url');
      if (nonce.byteLength !== NONCE_BYTES) throw new Error('invalid nonce');
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAAD(Buffer.from(TOKEN_VERSION));
      decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
      const parsed = tokenPayloadSchema.parse(JSON.parse(plaintext));
      if (parsed.expiresAt <= now) throw new Error('Instagram media token expired');
      return {
        workspaceId: parsed.workspaceId,
        mediaId: parsed.mediaId,
        expiresAt: parsed.expiresAt,
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'Instagram media token expired') throw error;
      throw new Error('Invalid Instagram media token');
    }
  }
}
