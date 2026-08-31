import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const requestIdMetaSchema = z.object({ requestId: z.string().min(1) });

export function successEnvelope<T>(
  data: T,
  requestId: string,
): {
  success: true;
  data: T;
  meta: { requestId: string };
} {
  return { success: true, data, meta: { requestId } };
}

export function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): {
  success: false;
  error: { code: string; message: string; requestId: string; details?: unknown };
} {
  return {
    success: false,
    error: { code, message, requestId, ...(details === undefined ? {} : { details }) },
  };
}

const cursorPayloadSchema = z.object({
  version: z.literal(1),
  position: z.string().min(1),
  filterHash: z.string().length(64),
  expiresAt: z.number().int().positive(),
});

function normalizeFilters(filters: Record<string, string | number | boolean | null>): string {
  return JSON.stringify(
    Object.entries(filters)
      .sort(([left], [right]) => left.localeCompare(right))
      .reduce<Record<string, string | number | boolean | null>>((result, [key, value]) => {
        result[key] = value;
        return result;
      }, {}),
  );
}

function filterHash(filters: Record<string, string | number | boolean | null>): string {
  return createHash('sha256').update(normalizeFilters(filters)).digest('hex');
}

function signature(encodedPayload: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(encodedPayload).digest();
}

export class InvalidCursorError extends Error {}

export class CursorCodec {
  public constructor(
    private readonly secret: Buffer,
    private readonly lifetimeMs = 24 * 60 * 60 * 1000,
  ) {
    if (secret.length < 32) throw new Error('Cursor signing secret must be at least 32 bytes');
  }

  public encode(
    position: string,
    filters: Record<string, string | number | boolean | null>,
    now = new Date(),
  ): string {
    const payload = cursorPayloadSchema.parse({
      version: 1,
      position,
      filterHash: filterHash(filters),
      expiresAt: now.getTime() + this.lifetimeMs,
    });
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encodedPayload}.${signature(encodedPayload, this.secret).toString('base64url')}`;
  }

  public decode(
    cursor: string,
    filters: Record<string, string | number | boolean | null>,
    now = new Date(),
  ): { position: string } {
    const [encodedPayload, encodedSignature, extra] = cursor.split('.');
    if (!encodedPayload || !encodedSignature || extra)
      throw new InvalidCursorError('Invalid cursor');
    const suppliedSignature = Buffer.from(encodedSignature, 'base64url');
    const expectedSignature = signature(encodedPayload, this.secret);
    if (
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    )
      throw new InvalidCursorError('Invalid cursor');
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
      throw new InvalidCursorError('Invalid cursor');
    }
    const payload = cursorPayloadSchema.safeParse(parsed);
    if (!payload.success) throw new InvalidCursorError('Invalid cursor');
    if (payload.data.expiresAt <= now.getTime()) throw new InvalidCursorError('Cursor expired');
    if (payload.data.filterHash !== filterHash(filters))
      throw new InvalidCursorError('Cursor filters do not match');
    return { position: payload.data.position };
  }
}
