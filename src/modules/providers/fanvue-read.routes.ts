import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { errorEnvelope, successEnvelope } from '../api/contract.js';
import type { ApiRateLimiter } from '../api/rate-limit.js';
import type { DelegatedAuthorizationService } from '../delegated-authorization/delegated-authorization.service.js';
import type { ApiKeyCapability } from '../identity/api-key.js';
import { ApiKeyAuthorizationError, type ApiKeyService } from '../identity/api-key.service.js';
import { authorizeMachineRequest, MachineAuthorizationError } from '../identity/machine-auth.js';
import { authorizeRequest } from '../identity/auth.routes.js';
import type { AuthService } from '../identity/auth.service.js';
import { WorkspaceAuthorizationError } from '../identity/authorization.js';
import { FanvueRequestError } from './fanvue-http-client.js';
import { FanvueReadUnavailableError, type FanvueReadService } from './fanvue-read.service.js';

const paramsSchema = z.object({
  accountId: z.uuid(),
  fanUuid: z.uuid().optional(),
  mediaUuid: z.uuid().optional(),
  postUuid: z.uuid().optional(),
  folderName: z.string().min(1).max(255).optional(),
});
const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  size: z.coerce.number().int().min(1).max(50).optional(),
  unreadOnly: z.enum(['true', 'false']).optional(),
  cursor: z.string().min(1).max(1024).optional(),
  mediaName: z.string().min(1).max(1000).optional(),
});
const historyBackfillBody = z.strictObject({
  maxPages: z.number().int().min(1).max(100).optional(),
  pageSize: z.number().int().min(1).max(50).optional(),
  excludeMediaForMessageUuids: z.array(z.uuid()).max(20).optional(),
});

interface ReadInput {
  workspaceId: string;
  accountId: string;
  page?: number;
  size?: number;
  unreadOnly?: boolean;
  fanUuid?: string;
  mediaUuid?: string;
  postUuid?: string;
  cursor?: string;
  folderName?: string;
  mediaName?: string;
}

function parseReadInput(request: FastifyRequest, workspaceId: string): ReadInput | null {
  const params = paramsSchema.safeParse(request.params);
  const query = querySchema.safeParse(request.query);
  if (!params.success || !query.success) return null;
  return {
    workspaceId,
    accountId: params.data.accountId,
    ...(params.data.fanUuid ? { fanUuid: params.data.fanUuid } : {}),
    ...(params.data.mediaUuid ? { mediaUuid: params.data.mediaUuid } : {}),
    ...(params.data.postUuid ? { postUuid: params.data.postUuid } : {}),
    ...(params.data.folderName ? { folderName: params.data.folderName } : {}),
    ...(query.data.page === undefined ? {} : { page: query.data.page }),
    ...(query.data.size === undefined ? {} : { size: query.data.size }),
    ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
    ...(query.data.mediaName === undefined ? {} : { mediaName: query.data.mediaName }),
    unreadOnly: query.data.unreadOnly === 'true',
  };
}

function readRoutes(service: FanvueReadService) {
  const routes: {
    path: string;
    capability: ApiKeyCapability;
    read: (input: ReadInput) => Promise<unknown>;
  }[] = [
    {
      path: '/api/v1/fanvue/accounts/:accountId/followers',
      capability: 'fanvue:audience:read',
      read: (input) => service.listFollowers(input),
    },
    {
      path: '/api/v1/fanvue/accounts/:accountId/subscribers',
      capability: 'fanvue:audience:read',
      read: (input) => service.listSubscribers(input),
    },
    {
      path: '/api/v1/fanvue/accounts/:accountId/chats',
      capability: 'fanvue:chats:read',
      read: (input) => service.listChats(input),
    },
    {
      path: '/api/v1/fanvue/accounts/:accountId/chats/:fanUuid/messages',
      capability: 'fanvue:chats:read',
      read: (input) => service.listMessages({ ...input, fanUuid: requiredId(input.fanUuid) }),
    },
    {
      path: '/api/v1/fanvue/accounts/:accountId/dm-conversations/due',
      capability: 'fanvue:chats:read',
      read: (input) => service.listDueDmConversations(input),
    },
    {
      path: '/api/v1/fanvue/accounts/:accountId/chats/:fanUuid/checkpoints',
      capability: 'fanvue:chats:read',
      read: (input) =>
        service.listDmConversationCheckpoints({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          fanUuid: requiredId(input.fanUuid),
        }),
    },
    {
      path: '/api/v1/fanvue/accounts/:accountId/media',
      capability: 'fanvue:media:read',
      read: (input) => service.listMedia(input),
    },
    {
      path: '/api/v1/fanvue/accounts/:accountId/media/:mediaUuid',
      capability: 'fanvue:media:read',
      read: (input) => service.getMediaStatus({ ...input, mediaUuid: requiredId(input.mediaUuid) }),
    },
    {
      path: '/api/v1/fanvue/accounts/:accountId/vault/folders',
      capability: 'fanvue:media:read',
      read: (input) => service.listVaultFolders(input),
    },
    {
      path: '/api/v1/fanvue/accounts/:accountId/vault/folders/:folderName/media',
      capability: 'fanvue:media:read',
      read: (input) =>
        service.listVaultFolderMedia({ ...input, folderName: requiredId(input.folderName) }),
    },
    {
      path: '/api/v1/fanvue/accounts/:accountId/posts',
      capability: 'fanvue:posts:read',
      read: (input) => service.listPosts(input),
    },
    {
      path: '/api/v1/fanvue/accounts/:accountId/posts/:postUuid',
      capability: 'fanvue:posts:read',
      read: (input) => service.getPost({ ...input, postUuid: requiredId(input.postUuid) }),
    },
    {
      path: '/api/v1/fanvue/accounts/:accountId/posts/:postUuid/comments',
      capability: 'fanvue:posts:read',
      read: (input) => service.listComments({ ...input, postUuid: requiredId(input.postUuid) }),
    },
  ];
  return routes;
}

export function registerFanvueReadRoutes(
  application: FastifyInstance,
  service: FanvueReadService,
  apiKeys: ApiKeyService,
  rateLimiter: ApiRateLimiter,
  delegatedAuthorization?: DelegatedAuthorizationService,
): void {
  for (const route of readRoutes(service)) {
    application.get(route.path, async (request, reply) => {
      try {
        const principal = await authorizeMachineRequest(
          request,
          apiKeys,
          delegatedAuthorization,
          route.capability,
        );
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const input = parseReadInput(request, principal.workspaceId);
        if (!input)
          return await reply
            .code(400)
            .send(errorEnvelope('invalid_request', 'Invalid Fanvue read request', request.id));
        const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'read');
        if (!decision.allowed) {
          void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
          return await reply
            .code(429)
            .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        }
        const data = await route.read(input);
        return await reply.send(successEnvelope(data, request.id));
      } catch (error) {
        return sendReadError(error, request, reply);
      }
    });
  }
  application.post(
    '/api/v1/fanvue/accounts/:accountId/chats/:fanUuid/history-backfill',
    async (request, reply) => {
      try {
        const principal = await authorizeMachineRequest(
          request,
          apiKeys,
          delegatedAuthorization,
          'fanvue:chats:read',
        );
        if (!principal)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const params = paramsSchema.safeParse(request.params);
        const body = historyBackfillBody.safeParse(request.body);
        if (!params.success || !params.data.fanUuid || !body.success)
          return await reply
            .code(400)
            .send(errorEnvelope('invalid_request', 'Invalid Fanvue backfill request', request.id));
        const decision = rateLimiter.check(principal.workspaceId, principal.actorId, 'read');
        if (!decision.allowed) {
          void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
          return await reply
            .code(429)
            .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        }
        const data = await service.backfillDmHistory({
          workspaceId: principal.workspaceId,
          accountId: params.data.accountId,
          fanUuid: params.data.fanUuid,
          ...(body.data.maxPages === undefined ? {} : { maxPages: body.data.maxPages }),
          ...(body.data.pageSize === undefined ? {} : { pageSize: body.data.pageSize }),
          ...(body.data.excludeMediaForMessageUuids === undefined
            ? {}
            : { excludeMediaForMessageUuids: body.data.excludeMediaForMessageUuids }),
        });
        return await reply.send(successEnvelope(data, request.id));
      } catch (error) {
        return sendReadError(error, request, reply);
      }
    },
  );
}

export function registerFanvueBrowserReadRoutes(
  application: FastifyInstance,
  service: FanvueReadService,
  auth: AuthService,
  rateLimiter: ApiRateLimiter,
): void {
  for (const route of readRoutes(service)) {
    application.get(route.path.replace('/api/v1/', '/api/'), async (request, reply) => {
      void reply.header('Cache-Control', 'no-store');
      try {
        const identity = await authorizeRequest(request, auth, 'content:read');
        if (!identity)
          return await reply
            .code(401)
            .send(errorEnvelope('authentication_required', 'Authentication required', request.id));
        const input = parseReadInput(request, identity.workspaceId);
        if (!input)
          return await reply
            .code(400)
            .send(errorEnvelope('invalid_request', 'Invalid Fanvue read request', request.id));
        const decision = rateLimiter.check(identity.workspaceId, identity.userId, 'read');
        if (!decision.allowed) {
          void reply.header('Retry-After', decision.retryAfterSeconds ?? 1);
          return await reply
            .code(429)
            .send(errorEnvelope('rate_limit_exceeded', 'Rate limit exceeded', request.id));
        }
        return await reply.send(successEnvelope(await route.read(input), request.id));
      } catch (error) {
        if (error instanceof WorkspaceAuthorizationError)
          return await reply
            .code(403)
            .send(errorEnvelope('forbidden', 'Access denied', request.id));
        return sendReadError(error, request, reply);
      }
    });
  }
}

function requiredId(id: string | undefined): string {
  if (!id) throw new Error('Missing validated Fanvue resource ID');
  return id;
}

function sendReadError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ApiKeyAuthorizationError || error instanceof MachineAuthorizationError)
    return reply.code(403).send(errorEnvelope(error.code, error.message, request.id));
  if (error instanceof FanvueReadUnavailableError) {
    const missing = error.reason === 'account_not_found';
    return reply
      .code(missing ? 404 : 409)
      .send(errorEnvelope(error.reason, error.message, request.id));
  }
  if (error instanceof FanvueRequestError) {
    const status =
      error.status === 429
        ? 429
        : error.status === 404
          ? 404
          : error.status === 401 || error.status === 403
            ? 409
            : 502;
    return reply
      .code(status)
      .send(
        errorEnvelope(
          'provider_read_failed',
          'Fanvue read failed; retry or reconnect the account',
          request.id,
        ),
      );
  }
  throw error;
}
