import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import { authenticateRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { ActionPolicyDeniedError, type ActionPolicy } from '../policy/action-policy.js';
import { verifyCsrfToken } from '../identity/session.js';
import type { XHttpClient } from './x-http-client.js';
import { beginXOauthConnection, completeXOauthConnection } from './x-oauth.service.js';

const callbackQuerySchema = z.object({
  oauth_token: z.string().min(1),
  oauth_verifier: z.string().min(1),
});

export function registerXOauthRoutes(
  application: FastifyInstance,
  dependencies: {
    auth: AuthService;
    database: NodePgDatabase;
    keys: MasterKeyProvider;
    client: XHttpClient;
    callbackUrl: string;
    actionPolicy: ActionPolicy;
  },
): void {
  application.post('/api/oauth/x', async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies.auth);
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (
      !verifyCsrfToken(
        request.cookies[CSRF_COOKIE],
        request.headers['x-csrf-token'] as string | undefined,
      )
    )
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    try {
      const result = await beginXOauthConnection(
        dependencies.database,
        dependencies.keys,
        dependencies.client,
        {
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          callbackUrl: dependencies.callbackUrl,
          requestId: request.id,
        },
        dependencies.actionPolicy,
      );
      return { data: result, error: null };
    } catch (error) {
      if (error instanceof ActionPolicyDeniedError)
        return reply.code(403).send({ data: null, error: error.message, code: error.code });
      throw error;
    }
  });

  application.get('/api/oauth/x/callback', async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies.auth);
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const query = callbackQuerySchema.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ data: null, error: 'Invalid X OAuth callback' });
    const result = await completeXOauthConnection(
      dependencies.database,
      dependencies.keys,
      dependencies.client,
      {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        requestToken: query.data.oauth_token,
        verifier: query.data.oauth_verifier,
        requestId: request.id,
      },
    );
    return result
      ? reply.redirect('/app?oauth=x-connected')
      : reply.code(400).send({ data: null, error: 'X OAuth transaction is invalid or expired' });
  });
}
