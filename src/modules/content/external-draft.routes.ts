import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import { executeIdempotentMutation } from '../api/idempotency.repository.js';
import { mutationFingerprint, validateIdempotencyKey } from '../api/idempotency.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import type { ExternalDraftRecord } from './external-draft.repository.js';
import {
  createExternalDraftInTransaction,
  ExternalDraftConflictError,
  ExternalDraftValidationError,
  getExternalDraft,
} from './external-draft.service.js';

const createSchema = z.object({
  externalId: z.string(),
  mediaIds: z.array(z.uuid()),
  label: z.string().optional(),
  returnUrl: z.string().optional(),
});

function representation(draft: ExternalDraftRecord) {
  return {
    id: draft.id,
    externalId: draft.externalId,
    label: draft.label,
    returnUrl: draft.returnUrl,
    mediaIds: draft.mediaIds,
    postId: draft.postId,
    createdAt: draft.createdAt.toISOString(),
    links: {
      self: `/api/v1/drafts/${draft.id}`,
      cockpit: `/w/${draft.workspaceSlug}/drafts/${draft.id}`,
      ...(draft.postId ? { post: `/api/v1/posts/${draft.postId}` } : {}),
    },
  };
}

function sendKnownError(error: unknown, requestId: string) {
  if (error instanceof ExternalDraftConflictError)
    return {
      status: 409,
      body: errorEnvelope('draft_conflict', 'externalId already has different input', requestId),
    };
  if (error instanceof ExternalDraftValidationError || error instanceof z.ZodError)
    return { status: 400, body: errorEnvelope('invalid_request', error.message, requestId) };
  if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
    return { status: 403, body: errorEnvelope(error.code, error.message, requestId) };
  return null;
}

export function registerExternalDraftRoutes(
  application: FastifyInstance,
  database: NodePgDatabase,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
): void {
  application.post('/api/v1/drafts', async (request, reply) => {
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
      if (!decision.allowed)
        return await reply
          .code(429)
          .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
      const body = createSchema.parse(request.body);
      const input = {
        externalId: body.externalId,
        mediaIds: body.mediaIds,
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.returnUrl !== undefined ? { returnUrl: body.returnUrl } : {}),
        requestId: request.id,
      };
      const suppliedKey = request.headers['idempotency-key'];
      const idempotencyKey = validateIdempotencyKey(
        typeof suppliedKey === 'string' ? suppliedKey : undefined,
      );
      const result = await executeIdempotentMutation(
        database,
        {
          workspaceId: principal.workspaceId,
          actor: { type: principal.kind, id: principal.actorId },
          operation: 'external-draft.create',
          idempotencyKey,
          requestFingerprint: mutationFingerprint(body),
        },
        async (transaction) => {
          const created = await createExternalDraftInTransaction(transaction, principal, input);
          return {
            statusCode: created.replayed ? 200 : 201,
            body: successEnvelope(representation(created.draft), request.id),
          };
        },
      );
      if (result.kind === 'conflict')
        return await reply
          .code(409)
          .send(
            errorEnvelope('idempotency_conflict', 'Idempotency key was already used', request.id),
          );
      if (result.kind === 'replayed') void reply.header('Idempotency-Replayed', 'true');
      return await reply.code(result.response.statusCode).send(result.response.body);
    } catch (error) {
      const known = sendKnownError(error, request.id);
      if (known) return await reply.code(known.status).send(known.body);
      request.log.error({ err: error }, 'External draft creation failed');
      return await reply
        .code(500)
        .send(errorEnvelope('internal_error', 'Internal server error', request.id));
    }
  });

  application.get('/api/v1/drafts/:draftId', async (request, reply) => {
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
      const { draftId } = z.object({ draftId: z.uuid() }).parse(request.params);
      const draft = await getExternalDraft(database, principal, draftId);
      if (!draft)
        return await reply
          .code(404)
          .send(errorEnvelope('not_found', 'Draft not found', request.id));
      return await reply.send(successEnvelope(representation(draft), request.id));
    } catch (error) {
      const known = sendKnownError(error, request.id);
      if (known) return await reply.code(known.status).send(known.body);
      request.log.error({ err: error }, 'External draft detail failed');
      return await reply
        .code(500)
        .send(errorEnvelope('internal_error', 'Internal server error', request.id));
    }
  });
}
