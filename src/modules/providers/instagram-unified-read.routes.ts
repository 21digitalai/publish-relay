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
import {
  createInstagramUnifiedReadService,
  instagramUnifiedReadStatus,
} from './instagram-unified-read.service.js';
import type { InstagramUnifiedReadClient } from './instagram-unified-read-client.js';

const params = z.object({ accountId: z.uuid(), mediaId: z.string().min(1).max(256).optional() });
const query = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  after: z.string().min(1).max(2048).optional(),
});

export function registerInstagramUnifiedReadRoutes(
  application: FastifyInstance,
  runtime: {
    database: NodePgDatabase;
    keys: MasterKeyProvider;
    client: InstagramUnifiedReadClient;
  },
  auth: AuthService,
) {
  const service = createInstagramUnifiedReadService(runtime);
  application.get(
    '/api/provider-accounts/:accountId/instagram-unified/status',
    async (request, reply) => {
      const identity = await authorizeRequest(request, auth, 'content:read');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      const parsed = params.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ data: null, error: 'Invalid account' });
      try {
        return {
          data: await service.permissions({
            workspaceId: identity.workspaceId,
            accountId: parsed.data.accountId,
          }),
          error: null,
        };
      } catch (error) {
        const outcome = instagramUnifiedReadStatus(error);
        return reply.code(outcome.status).send({ data: null, error: outcome.error });
      }
    },
  );
  for (const kind of ['media', 'comments'] as const)
    application.get(
      `/api/provider-accounts/:accountId/instagram-unified-${kind}${kind === 'comments' ? '/:mediaId' : ''}`,
      async (request, reply) => {
        const identity = await authorizeRequest(request, auth, 'content:read');
        if (!identity)
          return reply.code(401).send({ data: null, error: 'Authentication required' });
        const input = params.safeParse(request.params);
        const filters = query.safeParse(request.query);
        if (!input.success || !filters.success || (kind === 'comments' && !input.data.mediaId))
          return reply
            .code(400)
            .send({ data: null, error: 'Invalid Unified Instagram read query' });
        try {
          const data =
            kind === 'media'
              ? await service.media({
                  workspaceId: identity.workspaceId,
                  accountId: input.data.accountId,
                  ...(filters.data.limit === undefined ? {} : { limit: filters.data.limit }),
                  ...(filters.data.after === undefined ? {} : { after: filters.data.after }),
                })
              : await service.comments({
                  workspaceId: identity.workspaceId,
                  accountId: input.data.accountId,
                  mediaId: input.data.mediaId ?? '',
                  ...(filters.data.limit === undefined ? {} : { limit: filters.data.limit }),
                  ...(filters.data.after === undefined ? {} : { after: filters.data.after }),
                });
          return { data, error: null };
        } catch (error) {
          const outcome = instagramUnifiedReadStatus(error);
          return reply.code(outcome.status).send({ data: null, error: outcome.error });
        }
      },
    );
  application.get(
    '/api/provider-accounts/:accountId/instagram-unified-conversations',
    async (request, reply) => {
      const identity = await authorizeRequest(request, auth, 'content:read');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      const input = params.safeParse(request.params);
      const filters = query.safeParse(request.query);
      if (!input.success || !filters.success)
        return reply
          .code(400)
          .send({ data: null, error: 'Invalid Unified Instagram conversation query' });
      try {
        return {
          data: await service.conversations({
            workspaceId: identity.workspaceId,
            accountId: input.data.accountId,
            ...(filters.data.limit === undefined ? {} : { limit: filters.data.limit }),
            ...(filters.data.after === undefined ? {} : { after: filters.data.after }),
          }),
          error: null,
        };
      } catch (error) {
        const outcome = instagramUnifiedReadStatus(error);
        return reply.code(outcome.status).send({ data: null, error: outcome.error });
      }
    },
  );
  application.get(
    '/api/provider-accounts/:accountId/instagram-unified-conversations/:conversationId/messages',
    async (request, reply) => {
      const identity = await authorizeRequest(request, auth, 'content:read');
      if (!identity) return reply.code(401).send({ data: null, error: 'Authentication required' });
      const input = params
        .extend({ conversationId: z.string().min(1).max(256) })
        .safeParse(request.params);
      const filters = query.safeParse(request.query);
      if (!input.success || !filters.success)
        return reply
          .code(400)
          .send({ data: null, error: 'Invalid Unified Instagram message query' });
      try {
        return {
          data: await service.messages({
            workspaceId: identity.workspaceId,
            accountId: input.data.accountId,
            conversationId: input.data.conversationId,
            ...(filters.data.limit === undefined ? {} : { limit: filters.data.limit }),
            ...(filters.data.after === undefined ? {} : { after: filters.data.after }),
          }),
          error: null,
        };
      } catch (error) {
        const outcome = instagramUnifiedReadStatus(error);
        return reply.code(outcome.status).send({ data: null, error: outcome.error });
      }
    },
  );
}

export function registerInstagramUnifiedReadApiRoutes(
  application: FastifyInstance,
  runtime: {
    database: NodePgDatabase;
    keys: MasterKeyProvider;
    client: InstagramUnifiedReadClient;
  },
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
) {
  const service = createInstagramUnifiedReadService(runtime);
  application.get(
    '/api/v1/destinations/:accountId/instagram-unified-status',
    async (request, reply) => {
      const input = params.safeParse(request.params);
      if (!input.success)
        return reply
          .code(400)
          .send(errorEnvelope('invalid_request', 'Invalid Unified Instagram account', request.id));
      try {
        const principal = await authorizeMachineRequest(
          request,
          apiKeys,
          delegatedAuthorization,
          'destinations:read',
        );
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'read');
        if (!decision.allowed)
          return await reply
            .code(429)
            .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        return await reply.send(
          successEnvelope(
            await service.permissions({
              workspaceId: principal.workspaceId,
              accountId: input.data.accountId,
            }),
            request.id,
          ),
        );
      } catch (error) {
        if (error instanceof MachineAuthorizationError)
          return reply
            .code(403)
            .send(errorEnvelope(error.code, 'Unified Instagram status access denied', request.id));
        const outcome = instagramUnifiedReadStatus(error);
        return reply
          .code(outcome.status)
          .send(errorEnvelope('provider_read_failed', outcome.error, request.id));
      }
    },
  );
  for (const kind of ['media', 'comments'] as const)
    application.get(
      `/api/v1/destinations/:accountId/instagram-unified-${kind}${kind === 'comments' ? '/:mediaId' : ''}`,
      async (request, reply) => {
        const input = params.safeParse(request.params);
        const filters = query.safeParse(request.query);
        if (!input.success || !filters.success || (kind === 'comments' && !input.data.mediaId))
          return reply
            .code(400)
            .send(
              errorEnvelope('invalid_request', 'Invalid Unified Instagram read query', request.id),
            );
        try {
          const principal = await authorizeMachineRequest(
            request,
            apiKeys,
            delegatedAuthorization,
            kind === 'comments' ? 'comments:read' : 'destinations:read',
          );
          if (!principal)
            return await reply
              .code(401)
              .send(
                errorEnvelope('authentication_required', 'Authentication required', request.id),
              );
          const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'read');
          if (!decision.allowed)
            return await reply
              .code(429)
              .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
          const data =
            kind === 'media'
              ? await service.media({
                  workspaceId: principal.workspaceId,
                  accountId: input.data.accountId,
                  ...(filters.data.limit === undefined ? {} : { limit: filters.data.limit }),
                  ...(filters.data.after === undefined ? {} : { after: filters.data.after }),
                })
              : await service.comments({
                  workspaceId: principal.workspaceId,
                  accountId: input.data.accountId,
                  mediaId: input.data.mediaId ?? '',
                  ...(filters.data.limit === undefined ? {} : { limit: filters.data.limit }),
                  ...(filters.data.after === undefined ? {} : { after: filters.data.after }),
                });
          return await reply.send(successEnvelope(data, request.id));
        } catch (error) {
          if (error instanceof MachineAuthorizationError)
            return reply
              .code(403)
              .send(errorEnvelope(error.code, 'Unified Instagram read access denied', request.id));
          const outcome = instagramUnifiedReadStatus(error);
          return reply
            .code(outcome.status)
            .send(errorEnvelope('provider_read_failed', outcome.error, request.id));
        }
      },
    );
  application.get(
    '/api/v1/destinations/:accountId/instagram-unified-conversations',
    async (request, reply) => {
      const input = params.safeParse(request.params);
      const filters = query.safeParse(request.query);
      if (!input.success || !filters.success)
        return reply
          .code(400)
          .send(
            errorEnvelope(
              'invalid_request',
              'Invalid Unified Instagram conversation query',
              request.id,
            ),
          );
      try {
        const principal = await authorizeMachineRequest(
          request,
          apiKeys,
          delegatedAuthorization,
          'dms:read',
        );
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'read');
        if (!decision.allowed)
          return await reply
            .code(429)
            .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        return await reply.send(
          successEnvelope(
            await service.conversations({
              workspaceId: principal.workspaceId,
              accountId: input.data.accountId,
              ...(filters.data.limit === undefined ? {} : { limit: filters.data.limit }),
              ...(filters.data.after === undefined ? {} : { after: filters.data.after }),
            }),
            request.id,
          ),
        );
      } catch (error) {
        if (error instanceof MachineAuthorizationError)
          return await reply
            .code(403)
            .send(
              errorEnvelope(error.code, 'Unified Instagram conversation access denied', request.id),
            );
        const outcome = instagramUnifiedReadStatus(error);
        return await reply
          .code(outcome.status)
          .send(errorEnvelope('provider_read_failed', outcome.error, request.id));
      }
    },
  );
  application.get(
    '/api/v1/destinations/:accountId/instagram-unified-conversations/:conversationId/messages',
    async (request, reply) => {
      const input = params
        .extend({ conversationId: z.string().min(1).max(256) })
        .safeParse(request.params);
      const filters = query.safeParse(request.query);
      if (!input.success || !filters.success)
        return reply
          .code(400)
          .send(
            errorEnvelope('invalid_request', 'Invalid Unified Instagram message query', request.id),
          );
      try {
        const principal = await authorizeMachineRequest(
          request,
          apiKeys,
          delegatedAuthorization,
          'dms:read',
        );
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'read');
        if (!decision.allowed)
          return await reply
            .code(429)
            .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        return await reply.send(
          successEnvelope(
            await service.messages({
              workspaceId: principal.workspaceId,
              accountId: input.data.accountId,
              conversationId: input.data.conversationId,
              ...(filters.data.limit === undefined ? {} : { limit: filters.data.limit }),
              ...(filters.data.after === undefined ? {} : { after: filters.data.after }),
            }),
            request.id,
          ),
        );
      } catch (error) {
        if (error instanceof MachineAuthorizationError)
          return await reply
            .code(403)
            .send(errorEnvelope(error.code, 'Unified Instagram message access denied', request.id));
        const outcome = instagramUnifiedReadStatus(error);
        return await reply
          .code(outcome.status)
          .send(errorEnvelope('provider_read_failed', outcome.error, request.id));
      }
    },
  );
}
