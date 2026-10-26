import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import type { DmUploadKey } from './fanvue-dm-upload-init.repository.js';
import { FanvueRequestError } from './fanvue-http-client.js';
import { FanvueReadUnavailableError } from './fanvue-read.service.js';

const params = z.strictObject({ accountId: z.uuid() });
export const fanvueDmStageRequestSchema = z.strictObject({
  clientActionId: z.uuid(),
  mediaId: z.uuid(),
});
type Stage = (
  input: DmUploadKey,
) => Promise<'uploading' | 'processing' | 'ready' | 'unknown' | 'failed'>;

/** One request advances at most one durable provider phase; the caller repeats with the same IDs. */
export function registerFanvueDmStageRoutes(
  application: FastifyInstance,
  stage: Stage,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
): void {
  application.post('/api/v1/fanvue/accounts/:accountId/dm-media/stage', async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    try {
      const principal = await authorizeMachineRequest(
        request,
        apiKeys,
        delegatedAuthorization,
        'fanvue:media:upload',
      );
      if (!principal)
        return await reply
          .code(401)
          .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      const path = params.parse(request.params);
      const body = fanvueDmStageRequestSchema.parse(request.body);
      const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'mutation');
      if (!decision.allowed) {
        void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
        return await reply
          .code(429)
          .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
      }
      const state = await stage({
        workspaceId: principal.workspaceId,
        accountId: path.accountId,
        clientActionId: body.clientActionId,
        mediaId: body.mediaId,
      });
      return await reply
        .code(state === 'ready' ? 200 : 202)
        .send(successEnvelope({ state }, request.id));
    } catch (error) {
      return sendStageError(error, request, reply);
    }
  });
}

function sendStageError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
    return reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
  if (error instanceof z.ZodError)
    return reply
      .code(400)
      .send(errorEnvelope('invalid_request', 'Invalid stage request', request.id));
  if (error instanceof FanvueReadUnavailableError)
    return reply
      .code(error.reason === 'account_not_found' ? 404 : 409)
      .send(errorEnvelope(error.reason, error.message, request.id));
  if (error instanceof FanvueRequestError)
    return reply
      .code(502)
      .send(
        errorEnvelope(
          'provider_stage_failed',
          'Fanvue media stage failed; inspect state before retry',
          request.id,
        ),
      );
  request.log.error({ err: error }, 'Fanvue DM media stage failed');
  return reply
    .code(409)
    .send(
      errorEnvelope(
        'stage_unavailable',
        'Fanvue DM media stage unavailable; inspect state before retry',
        request.id,
      ),
    );
}
