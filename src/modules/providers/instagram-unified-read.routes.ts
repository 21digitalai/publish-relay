import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MasterKeyProvider } from '../credentials/envelope.js';
import type { AuthService } from '../identity/auth.service.js';
import { authorizeRequest } from '../identity/auth.routes.js';
import { createInstagramUnifiedReadService, instagramUnifiedReadStatus } from './instagram-unified-read.service.js';
import type { InstagramUnifiedReadClient } from './instagram-unified-read-client.js';

const params = z.object({ accountId: z.uuid(), mediaId: z.string().min(1).max(256).optional() });
const query = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), after: z.string().min(1).max(2048).optional() });

export function registerInstagramUnifiedReadRoutes(application: FastifyInstance, runtime: { database: NodePgDatabase; keys: MasterKeyProvider; client: InstagramUnifiedReadClient }, auth: AuthService) {
  const service = createInstagramUnifiedReadService(runtime);
  application.get('/api/provider-accounts/:accountId/instagram-unified/status', async (request, reply) => {
    const identity = await authorizeRequest(request, auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ data: null, error: 'Invalid account' });
    try { return { data: await service.permissions({ workspaceId: identity.workspaceId, accountId: parsed.data.accountId }), error: null }; }
    catch (error) { const outcome = instagramUnifiedReadStatus(error); return reply.code(outcome.status).send({ data: null, error: outcome.error }); }
  });
  for (const kind of ['media', 'comments'] as const) application.get(`/api/provider-accounts/:accountId/instagram-unified-${kind}${kind === 'comments' ? '/:mediaId' : ''}`, async (request, reply) => {
    const identity = await authorizeRequest(request, auth, 'content:read');
    if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
    const input = params.safeParse(request.params); const filters = query.safeParse(request.query);
    if (!input.success || !filters.success || (kind === 'comments' && !input.data.mediaId)) return reply.code(400).send({ data: null, error: 'Invalid Unified Instagram read query' });
    try { const data = kind === 'media' ? await service.media({ workspaceId: identity.workspaceId, accountId: input.data.accountId, ...(filters.data.limit === undefined ? {} : { limit: filters.data.limit }), ...(filters.data.after === undefined ? {} : { after: filters.data.after }) }) : await service.comments({ workspaceId: identity.workspaceId, accountId: input.data.accountId, mediaId: input.data.mediaId ?? '', ...(filters.data.limit === undefined ? {} : { limit: filters.data.limit }), ...(filters.data.after === undefined ? {} : { after: filters.data.after }) }); return { data, error: null }; }
    catch (error) { const outcome = instagramUnifiedReadStatus(error); return reply.code(outcome.status).send({ data: null, error: outcome.error }); }
  });
}
