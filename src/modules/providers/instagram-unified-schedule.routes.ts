import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import type { AuthService } from '../identity/auth.service.js';
import { authorizeRequest } from '../identity/auth.routes.js';
import type { InstagramUnifiedReadClient } from './instagram-unified-read-client.js';
import { createInstagramUnifiedScheduleService, InstagramUnifiedPendingConflictError } from './instagram-unified-schedule.service.js';
import { InstagramUnifiedEligibilityError } from './instagram-unified-send.service.js';

const params = z.strictObject({ accountId: z.uuid(), intentId: z.uuid().optional() });
const body = z.strictObject({ clientActionId: z.uuid(), kind: z.enum(['comment_reply', 'dm_reply']), targetId: z.string().min(1).max(256), parentId: z.string().min(1).max(256), recipientId: z.string().min(1).max(256).optional(), text: z.string().trim().min(1).max(2000), dueAt: z.iso.datetime({ offset: true }) });

export function registerInstagramUnifiedScheduleRoutes(application: FastifyInstance, runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: InstagramUnifiedReadClient }, auth: AuthService) {
  const service = createInstagramUnifiedScheduleService(runtime);
  application.post('/api/provider-accounts/:accountId/instagram-unified-schedules', async (request, reply) => {
    const identity = await authorizeRequest(request, auth, 'content:write');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const path = params.pick({ accountId: true }).safeParse(request.params); const parsed = body.safeParse(request.body);
    if (!path.success || !parsed.success) return reply.code(400).send({ data: null, error: 'Invalid Unified Instagram schedule' });
    try { return await reply.code(202).send({ data: await service.schedule({ ...parsed.data, accountId: path.data.accountId, workspaceId: identity.workspaceId, actor: { type: 'user', id: identity.userId } }), error: null }); }
    catch (error) { if (error instanceof InstagramUnifiedPendingConflictError) return reply.code(409).send({ data: null, error: error.message }); if (error instanceof InstagramUnifiedEligibilityError) return reply.code(409).send({ data: null, error: 'Unified Instagram reply is not currently eligible for scheduling' }); throw error; }
  });
  application.get('/api/provider-accounts/:accountId/instagram-unified-schedules/:intentId', async (request, reply) => {
    const identity = await authorizeRequest(request, auth, 'content:read'); if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const path = params.safeParse(request.params); if (!path.success || !path.data.intentId) return reply.code(400).send({ data: null, error: 'Invalid intent' });
    const result = await service.get({ workspaceId: identity.workspaceId, accountId: path.data.accountId, id: path.data.intentId });
    return result ? reply.send({ data: { id: result.id, status: result.status, dueAt: result.dueAt.toISOString() }, error: null }) : reply.code(404).send({ data: null, error: 'Intent not found' });
  });
  application.delete('/api/provider-accounts/:accountId/instagram-unified-schedules/:intentId', async (request, reply) => {
    const identity = await authorizeRequest(request, auth, 'content:write'); if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const path = params.safeParse(request.params); if (!path.success || !path.data.intentId) return reply.code(400).send({ data: null, error: 'Invalid intent' });
    const cancelled = await service.cancel({ workspaceId: identity.workspaceId, accountId: path.data.accountId, id: path.data.intentId });
    return cancelled ? reply.send({ data: { id: path.data.intentId, status: 'cancelled' }, error: null }) : reply.code(409).send({ data: null, error: 'Intent is not pending' });
  });
}
