import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import {
  authorizePageEngagementRequest,
  MachineAuthorizationError,
} from '../identity/machine-auth.js';
import { ActionPolicyDeniedError } from '../policy/action-policy.js';
import {
  cancelAccountPageCommentIntent,
  type CommentScheduleRuntime,
  getAccountPageCommentIntent,
  scheduleAccountPageCommentReply,
} from './facebook-comment-schedule.service.js';
import { PendingCommentConflictError } from './facebook-comment-pending.repository.js';
import { FacebookRequestError } from './facebook-http-client.js';
import { PageReadUnavailableError } from './facebook-page-read-context.service.js';

const targetParams = z.strictObject({
  accountId: z.uuid(),
  postId: z
    .string()
    .regex(/^[0-9]+(?:_[0-9]+)*$/)
    .max(256),
  commentId: z
    .string()
    .regex(/^[0-9]+(?:_[0-9]+)*$/)
    .max(256),
});
const intentParams = z.strictObject({ accountId: z.uuid(), intentId: z.uuid() });
export const facebookCommentScheduleRequestSchema = z.strictObject({
  clientActionId: z.uuid(),
  text: z.string().trim().min(1).max(2000),
  dueAt: z.iso.datetime({ offset: true }),
});

export function registerFacebookPageCommentScheduleRoutes(
  app: FastifyInstance,
  runtime: CommentScheduleRuntime,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
) {
  app.post(
    '/api/v1/destinations/:accountId/facebook-posts/:postId/comments/:commentId/replies/schedule',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      const path = targetParams.safeParse(request.params);
      const body = facebookCommentScheduleRequestSchema.safeParse(request.body);
      if (!path.success || !body.success)
        return reply
          .code(400)
          .send(
            errorEnvelope('invalid_request', 'Invalid Page comment schedule request', request.id),
          );
      try {
        const principal = await authorizePageEngagementRequest(
          request,
          apiKeys,
          delegatedAuthorization,
          runtime.database,
          path.data.accountId,
          'comments:send',
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
        const result = await scheduleAccountPageCommentReply(runtime, {
          workspaceId: principal.workspaceId,
          ...path.data,
          ...body.data,
          actor: { type: principal.kind, id: principal.actorId },
        });
        return await reply.code(202).send(successEnvelope(result, request.id));
      } catch (error) {
        if (
          error instanceof ApiKeyAuthorizationError ||
          error instanceof MachineAuthorizationError ||
          error instanceof ActionPolicyDeniedError
        )
          return await reply
            .code(403)
            .send(errorEnvelope('access_denied', 'Page comment access denied', request.id));
        if (error instanceof PendingCommentConflictError)
          return await reply
            .code(409)
            .send(errorEnvelope('action_conflict', error.message, request.id));
        if (error instanceof PageReadUnavailableError)
          return await reply
            .code(409)
            .send(errorEnvelope('page_comment_unavailable', error.message, request.id));
        if (error instanceof FacebookRequestError)
          return await reply
            .code(502)
            .send(
              errorEnvelope(
                'provider_preflight_failed',
                'Facebook comment preflight failed',
                request.id,
              ),
            );
        throw error;
      }
    },
  );

  async function accessIntent(request: FastifyRequest, accountId: string) {
    return authorizePageEngagementRequest(
      request,
      apiKeys,
      delegatedAuthorization,
      runtime.database,
      accountId,
      'comments:send',
    );
  }

  app.get(
    '/api/v1/destinations/:accountId/facebook-comment-replies/:intentId',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      const path = intentParams.safeParse(request.params);
      if (!path.success)
        return reply.code(400).send(errorEnvelope('invalid_request', 'Invalid intent', request.id));
      try {
        const principal = await accessIntent(request, path.data.accountId);
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const result = await getAccountPageCommentIntent(runtime.database, {
          workspaceId: principal.workspaceId,
          accountId: path.data.accountId,
          id: path.data.intentId,
        });
        return result
          ? await reply.send(successEnvelope(result, request.id))
          : await reply.code(404).send(errorEnvelope('not_found', 'Intent not found', request.id));
      } catch (error) {
        if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
          return await reply
            .code(403)
            .send(errorEnvelope('access_denied', 'Page comment access denied', request.id));
        throw error;
      }
    },
  );

  app.delete(
    '/api/v1/destinations/:accountId/facebook-comment-replies/:intentId',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      const path = intentParams.safeParse(request.params);
      if (!path.success)
        return reply.code(400).send(errorEnvelope('invalid_request', 'Invalid intent', request.id));
      try {
        const principal = await accessIntent(request, path.data.accountId);
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const cancelled = await cancelAccountPageCommentIntent(runtime.database, {
          workspaceId: principal.workspaceId,
          accountId: path.data.accountId,
          id: path.data.intentId,
        });
        return cancelled
          ? await reply.send(
              successEnvelope({ id: path.data.intentId, status: 'cancelled' }, request.id),
            )
          : await reply
              .code(409)
              .send(errorEnvelope('not_pending', 'Intent is not pending', request.id));
      } catch (error) {
        if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
          return await reply
            .code(403)
            .send(errorEnvelope('access_denied', 'Page comment access denied', request.id));
        throw error;
      }
    },
  );
}
