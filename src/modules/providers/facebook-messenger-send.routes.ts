import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import {
  authorizePageEngagementRequest,
  MachineAuthorizationError,
} from '../identity/machine-auth.js';
import { ActionPolicyDeniedError, type ActionPolicy } from '../policy/action-policy.js';
import { FacebookRequestError, type FacebookHttpClient } from './facebook-http-client.js';
import {
  FacebookDmActionConflictError,
  FacebookDmWindowClosedError,
  sendAccountPageConversationMessage,
} from './facebook-messenger-send.service.js';
import { PageReadUnavailableError } from './facebook-page-read-context.service.js';

const paramsSchema = z.strictObject({
  accountId: z.uuid(),
  conversationId: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/)
    .max(256),
});
export const facebookDmSendRequestSchema = z.strictObject({
  clientActionId: z.uuid(),
  text: z.string().trim().min(1).max(2000),
});

export function registerFacebookPageDmSendRoute(
  application: FastifyInstance,
  runtime: {
    database: NodePgDatabase;
    keys: MasterKeyProvider;
    client: FacebookHttpClient;
    policy: ActionPolicy;
  },
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
): void {
  application.post(
    '/api/v1/destinations/:accountId/facebook-conversations/:conversationId/messages',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      const path = paramsSchema.safeParse(request.params);
      const body = facebookDmSendRequestSchema.safeParse(request.body);
      if (!path.success || !body.success)
        return reply
          .code(400)
          .send(errorEnvelope('invalid_request', 'Invalid Page message request', request.id));
      try {
        const principal = await authorizePageEngagementRequest(
          request,
          apiKeys,
          delegatedAuthorization,
          runtime.database,
          path.data.accountId,
          'dms:send',
        );
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const limit = rateLimiter.check(principal.workspaceId, principal.actorId, 'mutation');
        if (!limit.allowed) {
          void reply.header('Retry-After', limit.retryAfterSeconds ?? 1);
          return await reply
            .code(429)
            .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        }
        const result = await sendAccountPageConversationMessage(runtime, {
          workspaceId: principal.workspaceId,
          accountId: path.data.accountId,
          conversationId: path.data.conversationId,
          clientActionId: body.data.clientActionId,
          text: body.data.text,
          actor: { type: principal.kind, id: principal.actorId },
        });
        const status = result.state === 'confirmed' ? 201 : result.state === 'unknown' ? 202 : 409;
        return await reply.code(status).send(successEnvelope(result, request.id));
      } catch (error) {
        if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
          return reply
            .code(403)
            .send(errorEnvelope(error.code, 'Page message access denied', request.id));
        if (error instanceof FacebookDmActionConflictError)
          return reply.code(409).send(errorEnvelope('action_conflict', error.message, request.id));
        if (error instanceof FacebookDmWindowClosedError)
          return reply
            .code(409)
            .send(errorEnvelope('messaging_window_unproven', error.message, request.id));
        if (error instanceof PageReadUnavailableError)
          return reply
            .code(409)
            .send(errorEnvelope('page_dm_unavailable', error.message, request.id));
        if (error instanceof ActionPolicyDeniedError)
          return reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
        if (error instanceof FacebookRequestError) {
          if (error.evidence.retryAfterSeconds !== undefined)
            void reply.header('Retry-After', error.evidence.retryAfterSeconds);
          return reply
            .code(error.evidence.kind === 'rate_limit' ? 429 : 502)
            .send(
              errorEnvelope(
                'provider_preflight_failed',
                'Facebook Page message preflight failed',
                request.id,
              ),
            );
        }
        throw error;
      }
    },
  );
}
