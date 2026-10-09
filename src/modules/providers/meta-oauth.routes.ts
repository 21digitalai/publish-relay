import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import type { MasterKeyProvider } from '../credentials/envelope.js';
import { ProviderDestinationConflictError } from '../credentials/provider-connection.repository.js';
import { authenticateRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { verifyCsrfToken } from '../identity/session.js';
import { ActionPolicyDeniedError, type ActionPolicy } from '../policy/action-policy.js';
import type { MetaHttpClient, MetaPermission } from './meta-http-client.js';
import { MetaRequestError } from './meta-http-client.js';
import {
  MetaConnectionHasActiveJobsError,
  MetaFamilyCallbackError,
  MetaNoUsableDestinationsError,
  beginMetaOauthConnection,
  completeMetaOauthConnection,
  failMetaOauthConnection,
  revokeMetaConnection,
  MetaRevocationPendingError,
} from './meta-oauth.service.js';

const successCallbackSchema = z.object({ state: z.string().min(1), code: z.string().min(1) });
const failureCallbackSchema = z.object({ state: z.string().min(1), error: z.string().min(1) });
const revokeSchema = z.object({ accountId: z.uuid() });

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
    familyPermissions?: Partial<Record<'facebook_pages' | 'instagram', readonly MetaPermission[]>>;
  },
): void {
  application.post('/api/oauth/meta', async (_request, reply) =>
    reply.code(410).send({ data: null, error: 'Choose Facebook Pages or Instagram separately' }),
  );
  application.post('/api/oauth/meta/instagram', async (_request, reply) =>
    reply.code(410).send({ data: null, error: 'Use Instagram Login to connect Instagram' }),
  );

  for (const family of ['facebook-pages'] as const)
    application.post(`/api/oauth/meta/${family}`, async (request, reply) => {
      const identity = await authenticateRequest(request, dependencies.auth);
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      if (!hasValidCsrf(request))
        return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
      const grantFamily = 'facebook_pages';
      const permissions = dependencies.familyPermissions?.[grantFamily];
      if (!permissions)
        return reply.code(503).send({
          data: null,
          error: 'Facebook Pages connection is not ready. No authorization was started.',
        });
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
            family: grantFamily,
            permissions,
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
      const consumed = await failMetaOauthConnection(dependencies.database, dependencies.keys, {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        state: failure.data.state,
        requestId: request.id,
      });
      return reply.redirect(
        consumed ? `/app?oauth=meta-${consumed}-denied` : '/app?oauth=meta-expired',
      );
    }
    const query = successCallbackSchema.safeParse(request.query);
    if (!query.success) return reply.redirect('/app?oauth=meta-expired');
    let result;
    try {
      result = await completeMetaOauthConnection(
        dependencies.database,
        dependencies.keys,
        dependencies.client,
        {
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          ...query.data,
          requestId: request.id,
        },
        dependencies.familyPermissions ?? {},
      );
    } catch (error) {
      if (error instanceof MetaFamilyCallbackError) {
        if (error.cause instanceof MetaRequestError)
          request.log.warn(
            {
              provider: 'meta',
              family: error.family,
              status: error.cause.status,
              ...error.cause.diagnostic,
            },
            'Meta OAuth provider validation failed',
          );
        const suffix =
          error.cause instanceof MetaNoUsableDestinationsError
            ? 'no-accounts'
            : error.cause instanceof ProviderDestinationConflictError
              ? 'conflict'
              : 'service-error';
        return reply.redirect(`/app?oauth=meta-${error.family}-${suffix}`);
      }
      if (error instanceof ProviderDestinationConflictError)
        return reply.redirect('/app?oauth=meta-conflict');
      if (error instanceof MetaRequestError) {
        request.log.warn(
          { provider: 'meta', status: error.status, ...error.diagnostic },
          'Meta OAuth provider validation failed',
        );
        return reply.redirect('/app?oauth=meta-service-error');
      }
      throw error;
    }
    if (!result) return reply.redirect('/app?oauth=meta-expired');
    return reply.redirect(
      `/app?oauth=meta-${result.family}-${result.accounts.length > 0 ? 'connected' : 'no-accounts'}`,
    );
  });

  application.post('/api/oauth/meta/revoke', async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies.auth);
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (!hasValidCsrf(request))
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const body = revokeSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ data: null, error: 'Select a Meta connection to revoke' });
    let revoked;
    try {
      revoked = await revokeMetaConnection(
        dependencies.database,
        dependencies.keys,
        dependencies.client,
        {
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          accountId: body.data.accountId,
          requestId: request.id,
        },
      );
    } catch (error) {
      if (error instanceof MetaConnectionHasActiveJobsError)
        return reply.code(409).send({ data: null, error: error.message });
      if (error instanceof MetaRevocationPendingError)
        return reply.code(503).send({ data: null, error: error.message });
      throw error;
    }
    return revoked
      ? { data: { ended: true }, error: null }
      : reply.code(404).send({ data: null, error: 'Meta connection was not found' });
  });
}
