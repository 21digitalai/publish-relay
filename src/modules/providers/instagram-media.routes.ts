import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';

import { mediaObjects } from '../../database/schema.js';
import { withTenantTransaction } from '../../database/tenant-transaction.js';
import type { MediaStorage } from '../content/media-storage.js';
import type { InstagramMediaTokenCodec } from './instagram-media-token.js';

export function registerInstagramMediaRoutes(
  application: FastifyInstance,
  dependencies: {
    database: NodePgDatabase;
    mediaStorage: MediaStorage;
    tokenCodec: InstagramMediaTokenCodec;
  },
): void {
  application.get<{ Params: { token: string } }>(
    '/provider-media/instagram/:token',
    async (request, reply) => {
      let token;
      try {
        token = dependencies.tokenCodec.verify(request.params.token);
      } catch {
        return reply.code(404).send();
      }
      const media = await withTenantTransaction(
        dependencies.database,
        { workspaceId: token.workspaceId },
        async (transaction) => {
          const [row] = await transaction
            .select({
              storageKey: mediaObjects.storageKey,
              mimeType: mediaObjects.mimeType,
              byteSize: mediaObjects.byteSize,
            })
            .from(mediaObjects)
            .where(
              and(
                eq(mediaObjects.workspaceId, token.workspaceId),
                eq(mediaObjects.id, token.mediaId),
                eq(mediaObjects.state, 'ready'),
                isNull(mediaObjects.deletedAt),
              ),
            )
            .limit(1);
          return row;
        },
      );
      if (!media) return reply.code(404).send();
      const bytes = await dependencies.mediaStorage.read(media.storageKey);
      if (bytes.byteLength !== media.byteSize) return reply.code(404).send();
      return reply
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .type(media.mimeType)
        .send(bytes);
    },
  );
}
