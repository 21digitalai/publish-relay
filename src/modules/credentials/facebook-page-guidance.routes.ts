import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { authorizeRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import {
  authorizePageEngagementRequest,
  MachineAuthorizationError,
} from '../identity/machine-auth.js';
import { verifyCsrfToken } from '../identity/session.js';
import {
  PAGE_GUIDANCE_LIMIT,
  getFacebookPageGuidance,
  updateFacebookPageGuidance,
  type PageGuidance,
} from './facebook-page-guidance.service.js';

const paramsSchema = z.object({ accountId: z.uuid() });
const field = z.string().refine((value) => Array.from(value).length <= PAGE_GUIDANCE_LIMIT);
const bodySchema = z.strictObject({ profile: field, dmGuidance: field, commentGuidance: field });

function sendResult(result: PageGuidance | null, request: FastifyRequest, reply: FastifyReply) {
  void reply.header('Cache-Control', 'no-store');
  return result === null
    ? reply
        .code(404)
        .send(errorEnvelope('account_not_found', 'Facebook Page not found', request.id))
    : reply.send(successEnvelope(result, request.id));
}

function invalid(request: FastifyRequest, reply: FastifyReply) {
  return reply
    .code(400)
    .send(
      errorEnvelope(
        'invalid_request',
        'Three guidance fields of at most 10,000 characters are required',
        request.id,
      ),
    );
}

export function registerFacebookPageGuidanceRoutes(
  application: FastifyInstance,
  database: NodePgDatabase,
  auth: AuthService | undefined,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
): void {
  for (const method of ['GET', 'PATCH'] as const) {
    application.route({
      method,
      url: '/api/v1/facebook-pages/:accountId/guidance',
      handler: async (request, reply) => {
        try {
          const params = paramsSchema.safeParse(request.params);
          if (!params.success) return await invalid(request, reply);
          const principal = await authorizePageEngagementRequest(
            request,
            apiKeys,
            delegatedAuthorization,
            database,
            params.data.accountId,
            method === 'GET' ? 'facebook:guidance:read' : 'facebook:guidance:write',
          );
          if (!principal)
            return await reply
              .code(401)
              .send(
                errorEnvelope('authentication_required', 'Authentication required', request.id),
              );
          const limit = rateLimiter.check(
            principal.workspaceId,
            principal.actorId,
            method === 'GET' ? 'read' : 'mutation',
          );
          if (!limit.allowed) {
            void reply.header('Retry-After', limit.retryAfterSeconds ?? 1);
            return await reply
              .code(429)
              .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
          }
          if (method === 'GET')
            return await sendResult(
              await getFacebookPageGuidance(database, {
                workspaceId: principal.workspaceId,
                accountId: params.data.accountId,
              }),
              request,
              reply,
            );
          const body = bodySchema.safeParse(request.body);
          if (!body.success) return await invalid(request, reply);
          return await sendResult(
            await updateFacebookPageGuidance(database, {
              workspaceId: principal.workspaceId,
              accountId: params.data.accountId,
              ...body.data,
              actor: {
                type: principal.kind === 'api-key' ? 'api_key' : 'delegated',
                id: principal.actorId,
              },
              requestId: request.id,
            }),
            request,
            reply,
          );
        } catch (error) {
          if (
            error instanceof ApiKeyAuthorizationError ||
            error instanceof MachineAuthorizationError
          )
            return reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
          throw error;
        }
      },
    });
  }

  if (!auth) return;
  for (const method of ['GET', 'PATCH'] as const) {
    application.route({
      method,
      url: '/api/facebook-pages/:accountId/guidance',
      handler: async (request, reply) => {
        const identity = await authorizeRequest(request, auth, 'workspace:manage');
        if (!identity)
          return reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        if (
          method === 'PATCH' &&
          !verifyCsrfToken(
            request.cookies[CSRF_COOKIE],
            request.headers['x-csrf-token'] as string | undefined,
          )
        )
          return reply
            .code(403)
            .send(errorEnvelope('csrf_failed', 'CSRF validation failed', request.id));
        const params = paramsSchema.safeParse(request.params);
        if (!params.success) return invalid(request, reply);
        if (method === 'GET')
          return sendResult(
            await getFacebookPageGuidance(database, {
              workspaceId: identity.workspaceId,
              accountId: params.data.accountId,
            }),
            request,
            reply,
          );
        const body = bodySchema.safeParse(request.body);
        if (!body.success) return invalid(request, reply);
        return sendResult(
          await updateFacebookPageGuidance(database, {
            workspaceId: identity.workspaceId,
            accountId: params.data.accountId,
            ...body.data,
            actor: { type: 'user', id: identity.userId },
            requestId: request.id,
          }),
          request,
          reply,
        );
      },
    });
  }
}
