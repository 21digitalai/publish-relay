import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import { authenticateRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { verifyCsrfToken } from '../identity/session.js';
import { ActionPolicyDeniedError, type ActionPolicy } from '../policy/action-policy.js';
import type { MetaHttpClient } from './meta-http-client.js';
import {
  beginMetaOauthConnection,
  completeMetaOauthConnection,
  failMetaOauthConnection,
  revokeMetaConnection,
} from './meta-oauth.service.js';

const successCallbackSchema = z.object({ state: z.string().min(1), code: z.string().min(1) });
const failureCallbackSchema = z.object({ state: z.string().min(1), error: z.string().min(1) });

function hasValidCsrf(request: {
  cookies: Record<string, string | undefined>;
  headers: Record<string, unknown>;
}): boolean {
  return verifyCsrfToken(
    request.cookies[CSRF_COOKIE],
    request.headers['x-csrf-token'] as string | undefined,
  );
}

export function registerMetaOauthRoutes(
  application: FastifyInstance,
  dependencies: {
    auth: AuthService;
    database: NodePgDatabase;
    keys: MasterKeyProvider;
    client: MetaHttpClient;
    callbackUrl: string;
    actionPolicy: ActionPolicy;
  },
): void {
  application.post('/api/oauth/meta', async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies.auth);
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!hasValidCsrf(request))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    try {
      const result = await beginMetaOauthConnection(
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

  application.get('/api/oauth/meta/callback', async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies.auth);
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const failure = failureCallbackSchema.safeParse(request.query);
    if (failure.success) {
      await failMetaOauthConnection(dependencies.database, dependencies.keys, {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        state: failure.data.state,
        requestId: request.id,
      });
      return reply.code(400).send({ data: null, error: 'Meta authorization was not completed' });
    }
    const query = successCallbackSchema.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ data: null, error: 'Invalid Meta OAuth callback' });
    const result = await completeMetaOauthConnection(
      dependencies.database,
      dependencies.keys,
      dependencies.client,
      {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        ...query.data,
        requestId: request.id,
      },
    );
    return result
      ? reply.redirect('/app?oauth=meta-connected')
      : reply.code(400).send({ data: null, error: 'Meta OAuth transaction is invalid or expired' });
  });

  application.post('/api/oauth/meta/revoke', async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies.auth);
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!hasValidCsrf(request))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const revoked = await revokeMetaConnection(
      dependencies.database,
      dependencies.keys,
      dependencies.client,
      {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        requestId: request.id,
      },
    );
    return revoked
      ? { data: { revoked: true }, error: null }
      : reply.code(404).send({ data: null, error: 'Meta connection was not found' });
  });
}
