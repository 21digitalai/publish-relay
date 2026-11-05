import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash, randomInt } from 'node:crypto';
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
  FacebookDmNoGoError,
  FacebookDmWindowClosedError,
  sendAccountPageConversationMessage,
} from './facebook-messenger-send.service.js';
import { PageReadUnavailableError } from './facebook-page-read-context.service.js';
import {
  cancelPendingPageDm,
  hasPendingPageDmAction,
  PendingDmConflictError,
  PendingDmNoGoError,
  schedulePageDm,
} from './facebook-dm-pending.repository.js';

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
  schedule: z
    .strictObject({
      earliestDelaySeconds: z.number().int().min(0).max(82_800),
      latestDelaySeconds: z.number().int().min(0).max(82_800),
    })
    .optional(),
});
const cancelParamsSchema = paramsSchema.extend({ intentId: z.uuid() });

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
        if (body.data.schedule) {
          const { earliestDelaySeconds, latestDelaySeconds } = body.data.schedule;
          if (latestDelaySeconds < earliestDelaySeconds)
            return await reply
              .code(400)
              .send(
                errorEnvelope('invalid_request', 'Invalid Page message delay window', request.id),
              );
          const delay = randomInt(earliestDelaySeconds, latestDelaySeconds + 1);
          const fingerprint = createHash('sha256')
            .update(
              JSON.stringify({
                accountId: path.data.accountId,
                conversationId: path.data.conversationId,
                text: body.data.text,
                earliestDelaySeconds,
                latestDelaySeconds,
              }),
            )
            .digest('hex');
          const intent = await schedulePageDm(runtime.database, {
            workspaceId: principal.workspaceId,
            accountId: path.data.accountId,
            conversationId: path.data.conversationId,
            clientActionId: body.data.clientActionId,
            requestFingerprint: fingerprint,
            text: body.data.text,
            dueAt: new Date(Date.now() + delay * 1000),
            actor: { type: principal.kind, id: principal.actorId },
          });
          return await reply
            .code(202)
            .send(
              successEnvelope(
                { id: intent.id, status: intent.status, dueAt: intent.dueAt.toISOString() },
                request.id,
              ),
            );
        }
        if (
          await hasPendingPageDmAction(runtime.database, {
            workspaceId: principal.workspaceId,
            clientActionId: body.data.clientActionId,
          })
        )
          return await reply
            .code(409)
            .send(errorEnvelope('action_conflict', 'Action ID already scheduled', request.id));
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
          return await reply
            .code(403)
            .send(errorEnvelope(error.code, 'Page message access denied', request.id));
        if (
          error instanceof FacebookDmActionConflictError ||
          error instanceof PendingDmConflictError
        )
          return reply.code(409).send(errorEnvelope('action_conflict', error.message, request.id));
        if (error instanceof PendingDmNoGoError)
          return reply.code(409).send(errorEnvelope('page_dm_no_go', error.message, request.id));
        if (error instanceof FacebookDmWindowClosedError)
          return reply
            .code(409)
            .send(errorEnvelope('messaging_window_unproven', error.message, request.id));
        if (error instanceof FacebookDmNoGoError)
          return reply.code(409).send(errorEnvelope('page_dm_no_go', error.message, request.id));
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
  application.delete(
    '/api/v1/destinations/:accountId/facebook-conversations/:conversationId/scheduled/:intentId',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      const path = cancelParamsSchema.safeParse(request.params);
      if (!path.success)
        return await reply
          .code(400)
          .send(errorEnvelope('invalid_request', 'Invalid scheduled Page message', request.id));
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
        const cancelled = await cancelPendingPageDm(runtime.database, {
          workspaceId: principal.workspaceId,
          accountId: path.data.accountId,
          conversationId: path.data.conversationId,
          id: path.data.intentId,
        });
        return await reply
          .code(cancelled ? 200 : 409)
          .send(
            cancelled
              ? successEnvelope({ status: 'cancelled' }, request.id)
              : errorEnvelope('not_pending', 'Scheduled message is no longer pending', request.id),
          );
      } catch (error) {
        if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
          return reply
            .code(403)
            .send(errorEnvelope(error.code, 'Page message access denied', request.id));
        throw error;
      }
    },
  );
}
