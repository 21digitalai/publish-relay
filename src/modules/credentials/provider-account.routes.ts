import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

import { authorizeRequest, CSRF_COOKIE } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { verifyCsrfToken } from '../identity/session.js';
import { disconnectProviderAccount, listProviderAccounts } from './provider-account.service.js';

const accountParamsSchema = z.object({ accountId: z.uuid() });

export function registerProviderAccountRoutes(
  application: FastifyInstance,
  dependencies: { auth: AuthService; database: NodePgDatabase },
): void {
  application.get('/api/provider-accounts', async (request, reply) => {
    const identity = await authorizeRequest(request, dependencies.auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const accounts = await listProviderAccounts(dependencies.database, identity.workspaceId);
    return { data: { accounts }, error: null };
  });

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
    return { data: { disconnected: true }, error: null };
  });
}
