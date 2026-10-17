import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import { ProviderDestinationConflictError } from '../credentials/provider-connection.repository.js';
import { authenticateRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { verifyCsrfToken } from '../identity/session.js';
import { ActionPolicyDeniedError, type ActionPolicy } from '../policy/action-policy.js';
import {
  InstagramLoginAccountError,
  InstagramLoginDiagnosticError,
  InstagramLoginPermissionError,
  type InstagramLoginClient,
} from './instagram-login-client.js';
import {
  beginInstagramLogin,
  completeInstagramLogin,
  failInstagramLogin,
  InstagramLoginPersistenceError,
} from './instagram-login.service.js';

const successSchema = z.object({ state: z.string().min(1), code: z.string().min(1) });
const failureSchema = z.object({ state: z.string().min(1), error: z.string().min(1) });

export function registerInstagramLoginRoutes(
  application: FastifyInstance,
  dependencies: {
    auth: AuthService;
    database: NodePgDatabase;
    actionPolicy: ActionPolicy;
    oauth?: { keys: MasterKeyProvider; client: InstagramLoginClient; callbackUrl: string };
  },
): void {
  application.post('/api/oauth/instagram', async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies.auth);
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (
      !verifyCsrfToken(
        request.cookies[CSRF_COOKIE],
        request.headers['x-csrf-token'] as string | undefined,
      )
    )
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const oauth = dependencies.oauth;
    if (!oauth)
      return reply.code(503).send({
        data: null,
        error: 'Instagram Login is not configured yet. No authorization was started.',
      });
    try {
      const result = await beginInstagramLogin(
        dependencies.database,
        oauth.keys,
        oauth.client,
        {
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          callbackUrl: oauth.callbackUrl,
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

  application.get('/api/oauth/instagram/callback', async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies.auth);
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const oauth = dependencies.oauth;
    if (!oauth) return reply.redirect('/app?oauth=instagram-service-error');
    const denied = failureSchema.safeParse(request.query);
    if (denied.success) {
      const consumed = await failInstagramLogin(dependencies.database, oauth.keys, {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        state: denied.data.state,
        requestId: request.id,
      });
      return reply.redirect(`/app?oauth=instagram-${consumed ? 'denied' : 'expired'}`);
    }
    const query = successSchema.safeParse(request.query);
    if (!query.success) return reply.redirect('/app?oauth=instagram-expired');
    try {
      const connected = await completeInstagramLogin(
        dependencies.database,
        oauth.keys,
        oauth.client,
        {
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          state: query.data.state,
          code: query.data.code,
          requestId: request.id,
        },
      );
      return await reply.redirect(`/app?oauth=instagram-${connected ? 'connected' : 'expired'}`);
    } catch (error) {
      const reason =
        error instanceof InstagramLoginPermissionError
          ? 'permissions'
          : error instanceof InstagramLoginAccountError
            ? 'no-account'
            : error instanceof ProviderDestinationConflictError
              ? 'conflict'
              : 'service-error';
      const diagnostic =
        error instanceof InstagramLoginDiagnosticError
          ? {
              stage: error.stage,
              category: error.category,
              ...(error.status === undefined ? {} : { status: error.status }),
              ...(error.shape === undefined ? {} : { responseShape: error.shape }),
            }
          : {
              stage:
                error instanceof ProviderDestinationConflictError ||
                error instanceof InstagramLoginPersistenceError
                  ? 'persistence'
                  : 'callback',
              category: error instanceof ProviderDestinationConflictError ? 'conflict' : 'internal',
            };
      request.log.warn(
        { provider: 'instagram', reason, ...diagnostic },
        'Instagram Login callback failed',
      );
      return reply.redirect(`/app?oauth=instagram-${reason}`);
    }
  });
}
