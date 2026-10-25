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
import { listAccountPagePosts, listAccountPostComments } from './facebook-comments-read.service.js';
import { FacebookRequestError, type FacebookHttpClient } from './facebook-http-client.js';
import { listAccountPageConversations } from './facebook-messenger-read.service.js';
import { PageReadUnavailableError } from './facebook-page-read-context.service.js';

const paramsSchema = z.object({
  accountId: z.uuid(),
  postId: z
    .string()
    .regex(/^[0-9]+(?:_[0-9]+)*$/)
    .optional(),
});
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  after: z.string().min(1).max(2048).optional(),
});

export function registerFacebookPageReadRoutes(
  application: FastifyInstance,
  runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: FacebookHttpClient },
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
): void {
  for (const endpoint of [
    { path: 'posts', capability: 'comments:read' as const, kind: 'posts' as const },
    {
      path: 'posts/:postId/comments',
      capability: 'comments:read' as const,
      kind: 'comments' as const,
    },
    { path: 'conversations', capability: 'dms:read' as const, kind: 'conversations' as const },
  ]) {
    application.get(
      `/api/v1/destinations/:accountId/facebook-${endpoint.path}`,
      async (request, reply) => {
        const params = paramsSchema.safeParse(request.params);
        const query = querySchema.safeParse(request.query);
        if (!params.success || !query.success)
          return reply
            .code(400)
            .send(errorEnvelope('invalid_request', 'Invalid Page read query', request.id));
        const postId = params.data.postId ?? '';
        if (endpoint.kind === 'comments' && !postId)
          return reply
            .code(400)
            .send(errorEnvelope('invalid_request', 'Invalid Page post', request.id));
        try {
          const principal = await authorizePageEngagementRequest(
            request,
            apiKeys,
            delegatedAuthorization,
            runtime.database,
            params.data.accountId,
            endpoint.capability,
          );
          if (!principal)
            return await reply
              .code(401)
              .send(
                errorEnvelope('authentication_required', 'Authentication required', request.id),
              );
          const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'read');
          if (!decision.allowed) {
            void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
            return await reply
              .code(429)
              .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
          }
          const input = {
            workspaceId: principal.workspaceId,
            accountId: params.data.accountId,
            ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
            ...(query.data.after === undefined ? {} : { after: query.data.after }),
          };
          const result =
            endpoint.kind === 'posts'
              ? await listAccountPagePosts(runtime, input)
              : endpoint.kind === 'comments'
                ? await listAccountPostComments(runtime, { ...input, postId })
                : await listAccountPageConversations(runtime, input);
          return await reply.send(successEnvelope(result, request.id));
        } catch (error) {
          if (
            error instanceof ApiKeyAuthorizationError ||
            error instanceof MachineAuthorizationError
          )
            return reply
              .code(403)
              .send(errorEnvelope(error.code, 'Page read access denied', request.id));
          if (error instanceof PageReadUnavailableError)
            return reply
              .code(409)
              .send(errorEnvelope('page_read_unavailable', error.message, request.id));
          if (error instanceof FacebookRequestError) {
            if (error.evidence.retryAfterSeconds !== undefined)
              void reply.header('Retry-After', error.evidence.retryAfterSeconds);
            const status =
              error.evidence.kind === 'rate_limit'
                ? 429
                : error.evidence.kind === 'permission' || error.evidence.kind === 'auth'
                  ? 409
                  : 502;
            return reply
              .code(status)
              .send(errorEnvelope('provider_read_failed', 'Facebook Page read failed', request.id));
          }
          throw error;
        }
      },
    );
  }
}
