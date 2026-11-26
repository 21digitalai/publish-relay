import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import type { AuthService } from '../identity/auth.service.js';
import { authorizeRequest } from '../identity/auth.routes.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import type { ApiKeyService } from '../identity/api-key.service.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import { errorEnvelope, successEnvelope } from '../api/contract.js';
import { createInstagramUnifiedSendService, InstagramUnifiedActionConflictError, InstagramUnifiedEligibilityError } from './instagram-unified-send.service.js';
import type { InstagramUnifiedReadClient } from './instagram-unified-read-client.js';

const body = z.strictObject({ clientActionId: z.uuid(), kind: z.enum(['comment_reply', 'dm_reply']), targetId: z.string().min(1).max(256), parentId: z.string().min(1).max(256), recipientId: z.string().min(1).max(256).optional(), text: z.string().trim().min(1).max(2000) });
const params = z.object({ accountId: z.uuid() });

function status(error: unknown) { if (error instanceof InstagramUnifiedActionConflictError) return 409; if (error instanceof InstagramUnifiedEligibilityError) return 409; return 502; }

export function registerInstagramUnifiedSendRoutes(application: FastifyInstance, runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: InstagramUnifiedReadClient }, auth: AuthService) {
  const service = createInstagramUnifiedSendService(runtime);
  application.post('/api/provider-accounts/:accountId/instagram-unified-actions', async (request, reply) => {
    const identity = await authorizeRequest(request, auth, 'content:write');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const target = params.safeParse(request.params); const parsed = body.safeParse(request.body);
    if (!target.success || !parsed.success) return reply.code(400).send({ data: null, error: 'Invalid Unified Instagram action' });
    try { return { data: await service.send({ ...parsed.data, accountId: target.data.accountId, workspaceId: identity.workspaceId, actor: { type: 'user', id: identity.userId } }), error: null }; }
    catch (error) { return reply.code(status(error)).send({ data: null, error: error instanceof InstagramUnifiedEligibilityError ? 'Unified Instagram reply is not currently eligible' : 'Unified Instagram action failed' }); }
  });
}

export function registerInstagramUnifiedSendApiRoutes(application: FastifyInstance, runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: InstagramUnifiedReadClient }, apiKeys: ApiKeyService, rateLimiter: ApiRateLimiter, delegatedAuthorization?: DelegatedAuthorizationService) {
  const service = createInstagramUnifiedSendService(runtime);
  application.post('/api/v1/destinations/:accountId/instagram-unified-actions', async (request, reply) => {
    const target = params.safeParse(request.params); const parsed = body.safeParse(request.body);
    if (!target.success || !parsed.success) return reply.code(400).send(errorEnvelope('invalid_request', 'Invalid Unified Instagram action', request.id));
    try {
      const principal = await authorizeMachineRequest(request, apiKeys, delegatedAuthorization, parsed.data.kind === 'comment_reply' ? 'comments:send' : 'dms:send');
      if (!principal) return reply.code(401).send(errorEnvelope('authentication_required', 'Authentication required', request.id));
      const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'mutation');
      if (!decision.allowed) return reply.code(429).send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
      const data = await service.send({ ...parsed.data, accountId: target.data.accountId, workspaceId: principal.workspaceId, actor: { type: principal.kind, id: principal.actorId } });
      return reply.send(successEnvelope(data, request.id));
    } catch (error) { if (error instanceof MachineAuthorizationError) return reply.code(403).send(errorEnvelope(error.code, 'Unified Instagram action access denied', request.id)); return reply.code(status(error)).send(errorEnvelope('action_failed', error instanceof InstagramUnifiedEligibilityError ? 'Unified Instagram reply is not currently eligible' : 'Unified Instagram action failed', request.id)); }
  });
}
