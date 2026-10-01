import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { MediaStorage } from '../content/media-storage.js';
import type { TikTokMediaGrantService } from './tiktok-media-grant.service.js';

interface ByteRange {
  start: number;
  end: number;
}

function parseRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last))
  )
    return null;
  const start = first ?? Math.max(0, size - (last ?? 0));
  const end = first === null ? size - 1 : Math.min(last ?? size - 1, size - 1);
  if (start >= size || end < start || (first === null && last === 0)) return null;
  return { start, end };
}

export function registerTikTokMediaRoutes(
  application: FastifyInstance,
  dependencies: { grants: TikTokMediaGrantService; mediaStorage: MediaStorage },
): void {
  application.get<{ Params: { grant: string; token: string } }>(
    '/provider-media/tiktok/:grant/:token',
    async (request, reply) => {
      if (request.protocol !== 'https') return reply.code(404).send();
      const grant = await dependencies.grants.resolve(request.params.grant, request.params.token);
      if (!grant) return reply.code(404).send();
      const rangeHeader = request.headers.range;
      const range = rangeHeader ? parseRange(rangeHeader, grant.byteSize) : null;
      if (rangeHeader && !range)
        return reply
          .code(416)
          .header('content-range', `bytes */${String(grant.byteSize)}`)
          .send();
      const start = range?.start ?? 0;
      const end = range?.end ?? grant.byteSize - 1;
      let body: Buffer | NodeJS.ReadableStream;
      if (dependencies.mediaStorage.openVerifiedRange) {
        const stream = await dependencies.mediaStorage.openVerifiedRange({
          storageKey: grant.storageKey,
          sha256: grant.sha256,
          byteSize: grant.byteSize,
          start,
          end,
        });
        if (!stream) return reply.code(404).send();
        body = stream;
      } else {
        let bytes: Buffer;
        try {
          bytes = await dependencies.mediaStorage.read(grant.storageKey);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send();
          throw error;
        }
        if (
          bytes.byteLength !== grant.byteSize ||
          createHash('sha256').update(bytes).digest('hex') !== grant.sha256
        )
          return reply.code(404).send();
        body = bytes.subarray(start, end + 1);
      }
      reply
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .header('accept-ranges', 'bytes')
        .header('content-length', end - start + 1)
        .type(grant.mimeType);
      if (range) {
        return reply
          .code(206)
          .header(
            'content-range',
            `bytes ${String(range.start)}-${String(range.end)}/${String(grant.byteSize)}`,
          )
          .send(body);
      }
      return reply.send(body);
    },
  );
}
