import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import { authenticateRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { verifyCsrfToken } from '../identity/session.js';
import { ActionPolicyDeniedError, type ActionPolicy } from '../policy/action-policy.js';
import type { LinkedInHttpClient } from './linkedin-http-client.js';
import { LinkedInRequestError } from './linkedin-http-client.js';
import {
  beginLinkedInConnection,
  completeLinkedInConnection,
  failLinkedInConnection,
  LinkedInMemberMismatchError,
} from './linkedin-oauth.service.js';

const callbackSchema = z.object({ state: z.string().min(1), code: z.string().min(1) });
const failureSchema = z.object({
  state: z.string().min(1),
  error: z.string().min(1),
  error_description: z.string().optional(),
});
const startSchema = z.object({ accountId: z.uuid().optional() });

export function registerLinkedInOauthRoutes(
  application: FastifyInstance,
  dependencies: {
    auth: AuthService;
    database: NodePgDatabase;
    keys: MasterKeyProvider;
    client: LinkedInHttpClient;
    callbackUrl: string;
    actionPolicy: ActionPolicy;
  },
): void {
  application.post('/api/oauth/linkedin', async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies.auth);
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (
      !verifyCsrfToken(
        request.cookies[CSRF_COOKIE],
        request.headers['x-csrf-token'] as string | undefined,
      )
    )
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const body = startSchema.safeParse(request.body ?? {});
    if (!body.success)
      return reply.code(400).send({ data: null, error: 'Invalid LinkedIn account' });
    try {
      const result = await beginLinkedInConnection(
        dependencies.database,
        dependencies.keys,
        dependencies.client,
        {
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          callbackUrl: dependencies.callbackUrl,
          requestId: request.id,
          ...(body.data.accountId ? { accountId: body.data.accountId } : {}),
        },
        dependencies.actionPolicy,
      );
      return { data: result, error: null };
    } catch (error) {
      if (error instanceof ActionPolicyDeniedError)
        return reply.code(403).send({ data: null, error: error.message, code: error.code });
      if (error instanceof Error && error.message.startsWith('The selected LinkedIn account'))
        return reply.code(404).send({ data: null, error: error.message });
      throw error;
    }
  });

  application.get('/api/oauth/linkedin/callback', async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies.auth);
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const failure = failureSchema.safeParse(request.query);
    if (failure.success) {
      const consumed = await failLinkedInConnection(dependencies.database, dependencies.keys, {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        state: failure.data.state,
      });
      return reply.redirect(
        consumed &&
          failure.data.error === 'unauthorized_scope_error' &&
          /(?:&quot;|")openid(?:&quot;|")/i.test(failure.data.error_description ?? '')
          ? '/app?oauth=linkedin-permission-unavailable'
          : consumed
            ? '/app?oauth=linkedin-denied'
            : '/app?oauth=linkedin-expired',
      );
    }
    const query = callbackSchema.safeParse(request.query);
    if (!query.success) return reply.redirect('/app?oauth=linkedin-expired');
    try {
      const result = await completeLinkedInConnection(
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
      if (result) return await reply.redirect('/app?oauth=linkedin-connected');
      return await reply.redirect('/app?oauth=linkedin-expired');
    } catch (error) {
      if (error instanceof LinkedInMemberMismatchError)
        return await reply.redirect('/app?oauth=linkedin-member-mismatch');
      if (error instanceof LinkedInRequestError)
        return await reply.redirect('/app?oauth=linkedin-service-error');
      throw error;
    }
  });
}
