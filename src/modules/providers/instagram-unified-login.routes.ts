import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import { authenticateRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { verifyCsrfToken } from '../identity/session.js';
import { ActionPolicyDeniedError, type ActionPolicy } from '../policy/action-policy.js';
import type { InstagramUnifiedLoginClient } from './instagram-unified-login-client.js';
import {
  beginInstagramUnifiedLogin,
  completeInstagramUnifiedLogin,
  failInstagramUnifiedLogin,
} from './instagram-unified-login.service.js';

const success = z.object({ state: z.string().min(1), code: z.string().min(1) });
const failure = z.object({ state: z.string().min(1), error: z.string().min(1) });

export function registerInstagramUnifiedLoginRoutes(
  application: FastifyInstance,
  dependencies: {
    auth: AuthService;
    database: NodePgDatabase;
    actionPolicy: ActionPolicy;
    oauth?: { keys: MasterKeyProvider; client: InstagramUnifiedLoginClient; callbackUrl: string };
  },
): void {
  application.post('/api/oauth/instagram-unified', async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies.auth);
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (
      !verifyCsrfToken(
        request.cookies[CSRF_COOKIE],
        request.headers['x-csrf-token'] as string | undefined,
      )
    )
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    if (!dependencies.oauth)
      return reply
        .code(503)
        .send({
          data: null,
          error: 'Instagram Unified Login is not configured yet. No authorization was started.',
        });
    try {
      return {
        data: await beginInstagramUnifiedLogin(
          dependencies.database,
          dependencies.oauth.keys,
          dependencies.oauth.client,
          { ...identity, requestId: request.id, callbackUrl: dependencies.oauth.callbackUrl },
          dependencies.actionPolicy,
        ),
        error: null,
      };
    } catch (error) {
      if (error instanceof ActionPolicyDeniedError)
        return reply.code(403).send({ data: null, error: error.message, code: error.code });
      throw error;
    }
  });
  application.get('/api/oauth/instagram-unified/callback', async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies.auth);
    if (!identity || !dependencies.oauth)
      return reply.redirect('/app?oauth=instagram-unified-service-error');
    const denied = failure.safeParse(request.query);
    if (denied.success)
      return reply.redirect(
        `/app?oauth=instagram-unified-${(await failInstagramUnifiedLogin(dependencies.database, dependencies.oauth.keys, { ...identity, requestId: request.id, state: denied.data.state })) ? 'denied' : 'expired'}`,
      );
    const query = success.safeParse(request.query);
    if (!query.success) return reply.redirect('/app?oauth=instagram-unified-expired');
    try {
      const result = await completeInstagramUnifiedLogin(
        dependencies.database,
        dependencies.oauth.keys,
        dependencies.oauth.client,
        { ...identity, requestId: request.id, ...query.data },
      );
      return reply.redirect(`/app?oauth=instagram-unified-${result ? 'connected' : 'expired'}`);
    } catch (error) {
      request.log.warn(
        { provider: 'instagram_unified_login' },
        'Instagram Unified Login callback failed',
      );
      return reply.redirect('/app?oauth=instagram-unified-service-error');
    }
  });
}
