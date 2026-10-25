import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import { ProviderDestinationConflictError } from '../credentials/provider-connection.repository.js';
import { authenticateRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { verifyCsrfToken } from '../identity/session.js';
import { ActionPolicyDeniedError, type ActionPolicy } from '../policy/action-policy.js';
import type { FanvueHttpClient } from './fanvue-http-client.js';
import {
  beginFanvueOauthConnection,
  completeFanvueOauthConnection,
  completeFanvueOauthDenial,
  FanvueModuleConsentError,
} from './fanvue-oauth.service.js';

const callbackSchema = z.object({ state: z.string().min(1), code: z.string().min(1) });
const deniedSchema = z.object({ state: z.string().min(1), error: z.literal('access_denied') });
const connectSchema = z.object({ readChatAccountId: z.uuid().optional() });

export function registerFanvueOauthRoutes(
  application: FastifyInstance,
  dependencies: {
    auth: AuthService;
    database: NodePgDatabase;
    keys: MasterKeyProvider;
    client: FanvueHttpClient;
    callbackUrl: string;
    actionPolicy: ActionPolicy;
  },
): void {
  application.post('/api/oauth/fanvue', async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies.auth);
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (
      !verifyCsrfToken(
        request.cookies[CSRF_COOKIE],
        request.headers['x-csrf-token'] as string | undefined,
      )
    )
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const body = connectSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ data: null, error: 'Invalid Fanvue account' });
    try {
      const result = await beginFanvueOauthConnection(
        dependencies.database,
        dependencies.keys,
        dependencies.client,
        {
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          callbackUrl: dependencies.callbackUrl,
          requestId: request.id,
          ...(body.data.readChatAccountId
            ? { readChatAccountId: body.data.readChatAccountId }
            : {}),
        },
        dependencies.actionPolicy,
      );
      return { data: result, error: null };
    } catch (error) {
      if (error instanceof FanvueModuleConsentError)
        return reply.code(409).send({
          data: null,
          error: 'Reconnect this Fanvue account and retry message-reading permission',
        });
      if (error instanceof ActionPolicyDeniedError)
        return reply.code(403).send({ data: null, error: error.message, code: error.code });
      throw error;
    }
  });

  application.get('/api/oauth/fanvue/callback', async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies.auth);
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const denied = deniedSchema.safeParse(request.query);
    if (denied.success) {
      const kind = await completeFanvueOauthDenial(dependencies.database, dependencies.keys, {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        state: denied.data.state,
      });
      if (!kind)
        return reply.code(400).send({ data: null, error: 'Fanvue connection attempt expired' });
      return kind === 'chat-read'
        ? reply.redirect('/app?oauth=fanvue-chat-read-denied')
        : reply.redirect('/app?oauth=fanvue-denied');
    }
    const query = callbackSchema.safeParse(request.query);
    if (!query.success)
      return reply
        .code(400)
        .send({ data: null, error: 'Fanvue connection was cancelled or invalid' });
    try {
      const result = await completeFanvueOauthConnection(
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
        ? await reply.redirect(
            result.consentKind === 'read-chat'
              ? '/app?oauth=fanvue-chat-read-connected'
              : '/app?oauth=fanvue-connected',
          )
        : await reply.code(400).send({
            data: null,
            error: 'Fanvue OAuth transaction is invalid or expired',
          });
    } catch (error) {
      if (error instanceof FanvueModuleConsentError)
        return reply.redirect(`/app?oauth=fanvue-chat-read-${error.reason}`);
      if (error instanceof ProviderDestinationConflictError)
        return reply.code(409).send({ data: null, error: error.message });
      throw error;
    }
  });
}
