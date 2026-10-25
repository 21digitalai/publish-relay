import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import { authorizeRequest } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
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

export function registerFacebookPageBrowserReadRoutes(
  application: FastifyInstance,
  runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: FacebookHttpClient },
  auth: AuthService,
): void {
  for (const endpoint of [
    { path: 'posts', kind: 'posts' as const },
    { path: 'posts/:postId/comments', kind: 'comments' as const },
    { path: 'conversations', kind: 'conversations' as const },
  ]) {
    application.get(
      `/api/provider-accounts/:accountId/facebook-${endpoint.path}`,
      async (request, reply) => {
        const identity = await authorizeRequest(request, auth, 'content:read');
        if (!identity)
          return reply.code(401).send({ data: null, error: 'Authentication required' });
        const params = paramsSchema.safeParse(request.params);
        const query = querySchema.safeParse(request.query);
        if (
          !params.success ||
          !query.success ||
          (endpoint.kind === 'comments' && !params.data.postId)
        )
          return reply.code(400).send({ data: null, error: 'Invalid Page read query' });
        void reply.header('Cache-Control', 'no-store');
        const input = {
          workspaceId: identity.workspaceId,
          accountId: params.data.accountId,
          ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
          ...(query.data.after === undefined ? {} : { after: query.data.after }),
        };
        try {
          const data =
            endpoint.kind === 'posts'
              ? await listAccountPagePosts(runtime, input)
              : endpoint.kind === 'comments'
                ? await listAccountPostComments(runtime, {
                    ...input,
                    postId: params.data.postId ?? '',
                  })
                : await listAccountPageConversations(runtime, input);
          return { data, error: null };
        } catch (error) {
          if (error instanceof PageReadUnavailableError)
            return reply.code(404).send({ data: null, error: 'Owned Page read is unavailable' });
          if (error instanceof FacebookRequestError) {
            if (error.evidence.retryAfterSeconds !== undefined)
              void reply.header('Retry-After', error.evidence.retryAfterSeconds);
            const status =
              error.evidence.kind === 'rate_limit'
                ? 429
                : error.evidence.kind === 'permission' || error.evidence.kind === 'auth'
                  ? 409
                  : 502;
            return reply.code(status).send({ data: null, error: 'Facebook Page read failed' });
          }
          throw error;
        }
      },
    );
  }
}
