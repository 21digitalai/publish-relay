import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { z } from 'zod';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import { executeIdempotentMutation } from '../api/idempotency.repository.js';
import { validateIdempotencyKey } from '../api/idempotency.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import {
  ActionPolicyDeniedError,
  allowAllActionPolicy,
  type ActionPolicy,
} from '../policy/action-policy.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import type { MediaStorage } from './media-storage.js';
import { FfprobeMediaProbe, type MediaProbe } from './media-probe.js';
import {
  detectMimeType,
  storeMediaInTransaction,
  storeStagedMediaInTransaction,
  validateMediaContentType,
} from './media.service.js';

export const AGENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const AGENT_MEDIA_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const AGENT_VIDEO_LIMITS = {
  maxDurationMs: 60 * 60 * 1000,
  maxWidth: 8192,
  maxHeight: 8192,
};
const SUPPORTED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
]);

export function registerMediaRoutes(
  application: FastifyInstance,
  database: NodePgDatabase,
  storage: MediaStorage,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  actionPolicy: ActionPolicy = allowAllActionPolicy,
  probe: MediaProbe = new FfprobeMediaProbe(),
  videoConfig = { maxBytes: AGENT_MEDIA_MAX_BYTES, limits: AGENT_VIDEO_LIMITS },
  delegatedAuthorization?: DelegatedAuthorizationService,
): void {
  for (const contentType of SUPPORTED_CONTENT_TYPES) {
    if (contentType === 'video/mp4') {
      application.addContentTypeParser(
        contentType,
        { bodyLimit: videoConfig.maxBytes },
        (_request, body, done) => {
          done(null, body);
        },
      );
      continue;
    }
    application.addContentTypeParser(
      contentType,
      {
        parseAs: 'buffer',
        bodyLimit: contentType === 'video/mp4' ? videoConfig.maxBytes : AGENT_IMAGE_MAX_BYTES,
      },
      (_request, body, done) => {
        done(null, body);
      },
    );
  }

  application.post('/api/v1/media', async (request, reply) => {
    let uncommittedStorageKey: string | undefined;
    try {
      const principal = await authorizeMachineRequest(
        request,
        apiKeys,
        delegatedAuthorization,
        'content:write',
      );
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'mutation');
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
        (contentType !== 'video/mp4' && !Buffer.isBuffer(request.body))
      )
        return await reply
          .code(400)
          .send(
            errorEnvelope(
              'invalid_request',
              'A supported media Content-Type is required',
              request.id,
            ),
          );
      z.string().min(1).max(255).parse(request.headers['x-file-name']);
      const suppliedKey = request.headers['idempotency-key'];
      const idempotencyKey = validateIdempotencyKey(
        typeof suppliedKey === 'string' ? suppliedKey : undefined,
      );
      if (contentType === 'video/mp4') {
        if (!storage.stageStream || !storage.promote || !probe.probeMp4File)
          throw new Error('Streaming media storage is unavailable');
        const staged = await storage.stageStream({
          stream: request.body as Readable,
          maxBytes: videoConfig.maxBytes,
          fingerprintPrefix: Buffer.from(`${contentType}\0`),
        });
        uncommittedStorageKey = staged.temporaryKey;
        if (detectMimeType(staged.prefix) !== contentType)
          throw new Error(`Media Content-Type mismatch: declared ${contentType}`);
        const metadata = await probe.probeMp4File(staged.filePath);
        if (metadata.durationMs > videoConfig.limits.maxDurationMs)
          throw new Error('Media duration exceeds the configured limit');
        if (
          metadata.width > videoConfig.limits.maxWidth ||
          metadata.height > videoConfig.limits.maxHeight
        )
          throw new Error('Media dimensions exceed the configured limit');
        const fingerprint = staged.requestFingerprint;
        const result = await executeIdempotentMutation(
          database,
          {
            workspaceId: principal.workspaceId,
            actor: { type: principal.kind, id: principal.actorId },
            operation: 'media.create',
            idempotencyKey,
            requestFingerprint: fingerprint,
          },
          async (transaction) => {
            const media = await storeStagedMediaInTransaction(
              transaction,
              storage,
              {
                workspaceId: principal.workspaceId,
                userId: principal.kind === 'api-key' ? principal.createdByUserId : principal.userId,
                actor: { type: principal.kind, id: principal.actorId },
                requestId: request.id,
                idempotencyKey,
                staged,
                mimeType: contentType,
                metadata,
              },
              actionPolicy,
            );
            uncommittedStorageKey = `${principal.workspaceId}/${media.mediaId}/${media.sha256}`;
            return {
              statusCode: 201,
              body: successEnvelope(
                {
                  id: media.mediaId,
                  mimeType: media.mimeType,
                  sha256: media.sha256,
                  byteSize: media.byteSize,
                  ...metadata,
                  state: 'ready',
                },
                request.id,
              ),
            };
          },
        );
        uncommittedStorageKey = undefined;
        if (result.kind === 'conflict') {
          await storage.delete(staged.temporaryKey);
          return await reply
            .code(409)
            .send(
              errorEnvelope('idempotency_conflict', 'Idempotency key was already used', request.id),
            );
        }
        if (result.kind === 'replayed') {
          await storage.delete(staged.temporaryKey);
          void reply.header('Idempotency-Replayed', 'true');
        }
        return await reply.code(result.response.statusCode).send(result.response.body);
      }
      const bytes = request.body as Buffer;
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
          actor: { type: principal.kind, id: principal.actorId },
          operation: 'media.create',
          idempotencyKey,
          requestFingerprint: fingerprint,
        },
        async (transaction) => {
          const media = await storeMediaInTransaction(
            transaction,
            storage,
            {
              workspaceId: principal.workspaceId,
              userId: principal.kind === 'api-key' ? principal.createdByUserId : principal.userId,
              actor: { type: principal.kind, id: principal.actorId },
              requestId: request.id,
              idempotencyKey,
              bytes,
              maxBytes: contentType === 'video/mp4' ? videoConfig.maxBytes : AGENT_IMAGE_MAX_BYTES,
              probe,
              limits: videoConfig.limits,
            },
            actionPolicy,
          );
          uncommittedStorageKey = `${principal.workspaceId}/${media.mediaId}/${media.sha256}`;
          return {
            statusCode: 201,
            body: successEnvelope(
              {
                id: media.mediaId,
                mimeType: media.mimeType,
                sha256: media.sha256,
                byteSize: media.byteSize,
                ...(media.metadata ?? {}),
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
      if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
        return await reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
      if (error instanceof ActionPolicyDeniedError)
        return await reply
          .code(403)
          .send(errorEnvelope(error.code, error.message, request.id, error.metadata));
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
