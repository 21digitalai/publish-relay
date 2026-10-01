import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { authorizeRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { verifyCsrfToken } from '../identity/session.js';
import { youtubeDestinationDefaultsSchema } from '../providers/youtube-settings.js';
import type { MasterKeyProvider } from './envelope.js';
import type { TikTokHttpClient } from '../providers/tiktok-http-client.js';
import { TikTokRequestError } from '../providers/tiktok-http-client.js';
import {
  fetchTikTokCapabilitySnapshot,
  TikTokCapabilityUnavailableError,
} from '../providers/tiktok-capabilities.service.js';
import {
  disconnectProviderAccount,
  listProviderAccounts,
  updateYouTubeAccountDefaults,
} from './provider-account.service.js';

const accountParamsSchema = z.object({ accountId: z.uuid() });

export function registerProviderAccountRoutes(
  application: FastifyInstance,
  dependencies: {
    auth: AuthService;
    database: NodePgDatabase;
    tiktok?: { keys: MasterKeyProvider; client: TikTokHttpClient };
  },
): void {
  application.get('/api/provider-accounts', async (request, reply) => {
    const identity = await authorizeRequest(request, dependencies.auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const accounts = await listProviderAccounts(dependencies.database, identity.workspaceId);
    return { data: { accounts }, error: null };
  });

  application.get(
    '/api/provider-accounts/:accountId/tiktok-capabilities',
    async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      const identity = await authorizeRequest(request, dependencies.auth, 'content:read');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      const params = accountParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ data: null, error: 'Invalid account' });
      if (!dependencies.tiktok)
        return reply.code(503).send({ data: null, error: 'TikTok options are unavailable' });
      try {
        const snapshot = await fetchTikTokCapabilitySnapshot(
          dependencies.database,
          dependencies.tiktok.keys,
          dependencies.tiktok.client,
          {
            workspaceId: identity.workspaceId,
            accountId: params.data.accountId,
            requestId: request.id,
          },
        );
        return { data: snapshot, error: null };
      } catch (error) {
        if (error instanceof TikTokCapabilityUnavailableError)
          return reply.code(409).send({ data: null, error: 'Reconnect this TikTok account' });
        if (error instanceof TikTokRequestError)
          return reply
            .code(502)
            .send({ data: null, error: 'TikTok options could not be refreshed' });
        throw error;
      }
    },
  );

  application.delete('/api/provider-accounts/:accountId', async (request, reply) => {
    const identity = await authorizeRequest(request, dependencies.auth, 'workspace:manage');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    if (
      !verifyCsrfToken(
        request.cookies[CSRF_COOKIE],
        request.headers['x-csrf-token'] as string | undefined,
      )
    )
      return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
    const params = accountParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ data: null, error: 'Invalid account' });
    const result = await disconnectProviderAccount(dependencies.database, {
      workspaceId: identity.workspaceId,
      userId: identity.userId,
      accountId: params.data.accountId,
      requestId: request.id,
    });
    if (result === 'missing')
      return reply.code(404).send({ data: null, error: 'Account was not found' });
    if (result === 'scheduled')
      return reply.code(409).send({
        data: null,
        error: 'Cancel scheduled jobs for this account before disconnecting it',
      });
    if (result === 'revoking')
      return reply.code(409).send({
        data: null,
        error: 'This Meta grant is being revoked; retry the grant revoke first',
      });
    return { data: { disconnected: true }, error: null };
  });

  application.patch(
    '/api/provider-accounts/:accountId/youtube-defaults',
    async (request, reply) => {
      const identity = await authorizeRequest(request, dependencies.auth, 'workspace:manage');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      if (
        !verifyCsrfToken(
          request.cookies[CSRF_COOKIE],
          request.headers['x-csrf-token'] as string | undefined,
        )
      )
        return reply.code(403).send({ data: null, error: 'CSRF validation failed' });
      const params = accountParamsSchema.safeParse(request.params);
      const defaults = youtubeDestinationDefaultsSchema.safeParse(request.body);
      if (!params.success || !defaults.success)
        return reply.code(400).send({ data: null, error: 'Invalid YouTube defaults' });
      const result = await updateYouTubeAccountDefaults(dependencies.database, {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        accountId: params.data.accountId,
        requestId: request.id,
        defaults: defaults.data,
      });
      if (result === 'missing')
        return reply.code(404).send({ data: null, error: 'YouTube account was not found' });
      return { data: { adapterDefaults: defaults.data }, error: null };
    },
  );
}
