import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import { executeIdempotentMutation } from '../api/idempotency.repository.js';
import { validateIdempotencyKey } from '../api/idempotency.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import { allowAllActionPolicy, type ActionPolicy } from '../policy/action-policy.js';
import { authorizeApiKeyRequest } from '../identity/api-key.routes.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import type { MediaStorage } from './media-storage.js';
import { storeMediaInTransaction, validateMediaContentType } from './media.service.js';

export const AGENT_MEDIA_MAX_BYTES = 5 * 1024 * 1024;
const SUPPORTED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function registerMediaRoutes(
  application: FastifyInstance,
  database: NodePgDatabase,
  storage: MediaStorage,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  actionPolicy: ActionPolicy = allowAllActionPolicy,
): void {
  for (const contentType of SUPPORTED_CONTENT_TYPES)
    application.addContentTypeParser(
      contentType,
      { parseAs: 'buffer', bodyLimit: AGENT_MEDIA_MAX_BYTES },
      (_request, body, done) => {
        done(null, body);
      },
    );

  application.post('/api/v1/media', async (request, reply) => {
    let uncommittedStorageKey: string | undefined;
    try {
      const principal = await authorizeApiKeyRequest(request, apiKeys, 'content:write');
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      const decision = rateLimiter.check(principal.workspaceId, principal.id, 'mutation');
      void reply.header('X-RateLimit-Limit', decision.limit);
      void reply.header('X-RateLimit-Remaining', decision.remaining);
      if (!decision.allowed) {
        void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
        return await reply
          .code(429)
          .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
      }
      const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
      if (
        !contentType ||
        !SUPPORTED_CONTENT_TYPES.has(contentType) ||
        !Buffer.isBuffer(request.body)
      )
        return await reply
          .code(400)
          .send(
            errorEnvelope(
              'invalid_request',
              'A supported image Content-Type is required',
              request.id,
            ),
          );
      z.string().min(1).max(255).parse(request.headers['x-file-name']);
      const suppliedKey = request.headers['idempotency-key'];
      const idempotencyKey = validateIdempotencyKey(
        typeof suppliedKey === 'string' ? suppliedKey : undefined,
      );
      const bytes = request.body;
      validateMediaContentType(bytes, contentType);
      const fingerprint = createHash('sha256')
        .update(contentType)
        .update('\0')
        .update(bytes)
        .digest('hex');
      const result = await executeIdempotentMutation(
        database,
        {
          workspaceId: principal.workspaceId,
          apiKeyId: principal.id,
          operation: 'media.create',
          idempotencyKey,
          requestFingerprint: fingerprint,
        },
        async (transaction) => {
          const media = await storeMediaInTransaction(transaction, storage, {
            workspaceId: principal.workspaceId,
            userId: principal.createdByUserId,
            bytes,
            maxBytes: AGENT_MEDIA_MAX_BYTES,
          }, actionPolicy);
          uncommittedStorageKey = `${principal.workspaceId}/${media.mediaId}/${media.sha256}`;
          return {
            statusCode: 201,
            body: successEnvelope(
              {
                id: media.mediaId,
                mimeType: media.mimeType,
                sha256: media.sha256,
                byteSize: media.byteSize,
                state: 'ready',
              },
              request.id,
            ),
          };
        },
      );
      uncommittedStorageKey = undefined;
      if (result.kind === 'conflict')
        return await reply
          .code(409)
          .send(
            errorEnvelope('idempotency_conflict', 'Idempotency key was already used', request.id),
          );
      if (result.kind === 'replayed') void reply.header('Idempotency-Replayed', 'true');
      return await reply.code(result.response.statusCode).send(result.response.body);
    } catch (error) {
      if (uncommittedStorageKey) {
        try {
          await storage.delete(uncommittedStorageKey);
        } catch {
          request.log.error({ storageKey: uncommittedStorageKey }, 'Media rollback cleanup failed');
        }
      }
      if (error instanceof ApiKeyAuthorizationError)
        return await reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
      if (
        error instanceof z.ZodError ||
        (error instanceof Error && /Media|Idempotency|Unsupported/.test(error.message))
      )
        return await reply
          .code(400)
          .send(errorEnvelope('invalid_request', error.message, request.id));
      request.log.error({ err: error }, 'Media mutation failed');
      return await reply
        .code(500)
        .send(errorEnvelope('internal_error', 'Internal server error', request.id));
    }
  });
}
