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
const deniedSchema = z.object({ state: z.string().min(1), error: z.string().min(1) });
const connectSchema = z
  .object({
    readChatAccountId: z.uuid().optional(),
    sendChatAccountId: z.uuid().optional(),
    paymentAccountId: z.uuid().optional(),
  })
  .refine(
    (value) =>
      [value.readChatAccountId, value.sendChatAccountId, value.paymentAccountId].filter(Boolean)
        .length <= 1,
  );

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
          ...(body.data.sendChatAccountId
            ? { sendChatAccountId: body.data.sendChatAccountId }
            : {}),
          ...(body.data.paymentAccountId ? { paymentAccountId: body.data.paymentAccountId } : {}),
        },
        dependencies.actionPolicy,
      );
      return { data: result, error: null };
    } catch (error) {
      if (error instanceof FanvueModuleConsentError)
        return reply.code(409).send({
          data: null,
          error: body.data.paymentAccountId
            ? 'Reconnect this Fanvue account and retry payment-signal permission'
            : body.data.sendChatAccountId
              ? 'Reconnect this Fanvue account and retry message-sending permission'
              : 'Reconnect this Fanvue account and retry message-reading permission',
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
      if (denied.data.error === 'invalid_scope')
        return reply.redirect(
          kind === 'publishing'
            ? '/app?oauth=fanvue-scope-unavailable'
            : `/app?oauth=fanvue-${kind}-app-scope`,
        );
      if (denied.data.error !== 'access_denied')
        return reply.redirect(
          kind === 'publishing'
            ? '/app?oauth=fanvue-provider-error'
            : `/app?oauth=fanvue-${kind}-provider-error`,
        );
      return kind === 'chat-read'
        ? reply.redirect('/app?oauth=fanvue-chat-read-denied')
        : kind === 'chat-send'
          ? reply.redirect('/app?oauth=fanvue-chat-send-denied')
          : kind === 'payment'
            ? reply.redirect('/app?oauth=fanvue-payment-denied')
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
            'consentKind' in result && result.consentKind === 'read-chat'
              ? '/app?oauth=fanvue-chat-read-connected'
              : 'consentKind' in result && result.consentKind === 'send-chat'
                ? '/app?oauth=fanvue-chat-send-connected'
                : 'consentKind' in result
                  ? '/app?oauth=fanvue-payment-connected'
                  : '/app?oauth=fanvue-connected',
          )
        : await reply.code(400).send({
            data: null,
            error: 'Fanvue OAuth transaction is invalid or expired',
          });
    } catch (error) {
      if (error instanceof FanvueModuleConsentError)
        return reply.redirect(
          error.kind === 'payment'
            ? `/app?oauth=fanvue-payment-${error.reason}`
            : `/app?oauth=fanvue-chat-${error.kind}-${error.reason}`,
        );
      if (error instanceof ProviderDestinationConflictError)
        return reply.code(409).send({ data: null, error: error.message });
      throw error;
    }
  });
}
